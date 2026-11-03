import { Hono } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';

// Framing headers Node re-derives for the upstream socket. Everything else
// (content-length, accept-encoding, custom headers, ...) passes through verbatim.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

// Temp discovery log: values the client actually sent. Never add session-like
// names here or the mapping exercise defeats itself.
// shortcut: narrow redaction set, remove LOG_HEADERS once the client session header is mapped.
const REDACTED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

function isToolsAutoCandidate(req, incomingPath, config) {
  if (!config.COPILOT_COMPACTION_TOOLS_AUTO) return false;
  if (req.method !== 'POST') return false;
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json' && !ct.endsWith('+json')) return false;
  const pathOnly = incomingPath.split('?')[0].toLowerCase();
  return pathOnly.endsWith('/chat/completions') || pathOnly.endsWith('/responses');
}

export function handleProxy(req, res, config) {
  const {
    TARGET_HOST,
    TARGET_PORT,
    upstreamRequest,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    OVERRIDE_KEY,
    SESSION_ID,
    USER_AGENT,
    LOG_HEADERS,
  } = config;

  // Pre-check declared Content-Length: reject oversized bodies BEFORE Node sends
  // 100 Continue or pipes anything upstream. Avoids the "accept then destroy"
  // race where the 413 can never reach the client because the socket is gone.
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_BODY_BYTES) {
    console.error(`[err] declared content-length ${declared} > ${MAX_BODY_BYTES}`);
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'payload_too_large', limit: MAX_BODY_BYTES, declared }));
    req.resume();
    return;
  }

  // Single-write guard: prevents ERR_STREAM_WRITE_AFTER_END when multiple
  // failure paths race (e.g. body-too-large unpipe + upstream error event).
  let responded = false;
  const sendJson = (status, body) => {
    if (responded || res.writableEnded) return;
    responded = true;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const incomingPath = (req.url || '/').replace(/[\x00-\x1f]/g, '');
  // Scoping is done by the router (mounted at /zen/go and /inference/go):
  // anything reaching here is forwarded unchanged, query included.
  const targetPath = incomingPath;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers[key] = value;
    }
  }

  headers.host = TARGET_HOST;
  // Fallbacks only: forward the client's values untouched when present.
  if (!headers['user-agent']) headers['user-agent'] = USER_AGENT;
  if (!headers['x-opencode-session']) headers['x-opencode-session'] = SESSION_ID;

  if (OVERRIDE_KEY) {
    headers.authorization = `Bearer ${OVERRIDE_KEY}`;
  }

  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: targetPath,
    method: req.method,
    headers,
  };

  const started = Date.now();
  console.log(`[req] ${req.method} ${incomingPath} -> https://${TARGET_HOST}${targetPath}`);
  if (LOG_HEADERS) {
    const safe = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (REDACTED_HEADERS.has(key.toLowerCase())) safe[key] = '[redacted]';
      else if (Array.isArray(value)) safe[key] = value.map((v) => String(v).replace(/[\r\n\t]/g, ''));
      else if (value !== undefined) safe[key] = String(value).replace(/[\r\n\t]/g, '');
    }
    console.log(`[headers] ${JSON.stringify(safe)}`);
  }

  // Opt-in Spark compaction fix: force tool_choice to auto. Buffered so the
  // JSON can be rewritten before anything is sent upstream. Non-candidates
  // fall through to the byte-for-byte pipe below.
  if (isToolsAutoCandidate(req, incomingPath, config)) {
    const chunks = [];
    let received = 0;
    let done = false;
    let proxyReq = null;

    req.setTimeout(REQUEST_TIMEOUT_MS);
    req.on('timeout', () => {
      console.error(`[err] client timeout after ${REQUEST_TIMEOUT_MS}ms`);
      sendJson(504, { error: 'client_timeout', timeout_ms: REQUEST_TIMEOUT_MS });
      try { req.destroy(); } catch {}
      if (proxyReq) try { proxyReq.destroy(); } catch {}
    });

    req.on('error', (err) => {
      console.error(`[err] client ${err.message}`);
      if (proxyReq) proxyReq.destroy();
    });

    // Client hung up while buffering (no upstream yet) or mid-upstream:
    // stop buffering, kill upstream so it stops burning quota.
    res.on('close', () => {
      if (proxyReq) {
        if (!res.writableEnded) proxyReq.destroy();
      } else {
        done = true;
      }
    });

    req.on('data', (chunk) => {
      if (done) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        done = true;
        console.error(`[err] payload too large (${received} > ${MAX_BODY_BYTES})`);
        req.resume();
        sendJson(413, { error: 'payload_too_large', limit: MAX_BODY_BYTES, received });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done || responded || res.writableEnded) return;
      const raw = Buffer.concat(chunks);
      let out = raw;
      try {
        const json = JSON.parse(raw.toString('utf8'));
        const model = typeof json?.model === 'string' ? json.model : '';
        if (model.toLowerCase().includes('muse-spark') && json.tool_choice !== 'auto') {
          const oldType =
            json.tool_choice === undefined ? 'missing' : Array.isArray(json.tool_choice) ? 'array' : typeof json.tool_choice;
          json.tool_choice = 'auto';
          out = Buffer.from(JSON.stringify(json));
          console.log(`[tools-auto] ${incomingPath} tool_choice ${oldType} -> auto`);
        }
      } catch {
        // Malformed JSON: forward untouched, let upstream decide.
      }
      headers['content-length'] = String(out.length);
      delete headers['transfer-encoding'];

      proxyReq = upstreamRequest(options, (proxyRes) => {
        if (responded || res.writableEnded) return;
        responded = true;
        const outHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
        }
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        proxyRes.on('error', (err) => {
          console.error(`[err] upstream response ${err.message} (${Date.now() - started}ms)`);
          try { proxyReq.destroy(); } catch {}
          if (!res.writableEnded) res.destroy();
        });
        proxyRes.pipe(res);
      });

      proxyReq.setTimeout(REQUEST_TIMEOUT_MS);
      proxyReq.on('timeout', () => {
        console.error(`[err] upstream timeout after ${REQUEST_TIMEOUT_MS}ms`);
        proxyReq.destroy(new Error('upstream timeout'));
      });

      proxyReq.on('error', (err) => {
        console.error(`[err] upstream ${err.message} (${Date.now() - started}ms)`);
        if (!res.headersSent) sendJson(502, { error: 'proxy_error', message: err.message });
        else if (!res.writableEnded) res.destroy();
      });

      if (out.length) proxyReq.write(out);
      proxyReq.end();
    });
    return;
  }

  // Timeouts (client side)
  req.setTimeout(REQUEST_TIMEOUT_MS);
  req.on('timeout', () => {
    console.error(`[err] client timeout after ${REQUEST_TIMEOUT_MS}ms`);
    sendJson(504, { error: 'client_timeout', timeout_ms: REQUEST_TIMEOUT_MS });
    req.destroy();
  });

  const proxyReq = upstreamRequest(options, (proxyRes) => {
    if (responded || res.writableEnded) return; // we already sent 413 / 502
    responded = true;
    const outHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders[key] = value;
    }
    res.writeHead(proxyRes.statusCode || 502, outHeaders);
    // Upstream dying mid-stream must end the client response, not hang it.
    proxyRes.on('error', (err) => {
      console.error(`[err] upstream response ${err.message} (${Date.now() - started}ms)`);
      proxyReq.destroy();
      if (!res.writableEnded) res.destroy();
    });
    proxyRes.pipe(res);
  });

  // Timeout (upstream)
  proxyReq.setTimeout(REQUEST_TIMEOUT_MS);
  proxyReq.on('timeout', () => {
    console.error(`[err] upstream timeout after ${REQUEST_TIMEOUT_MS}ms`);
    proxyReq.destroy(new Error('upstream timeout'));
  });

  proxyReq.on('error', (err) => {
    console.error(`[err] upstream ${err.message} (${Date.now() - started}ms)`);
    if (!res.headersSent) sendJson(502, { error: 'proxy_error', message: err.message });
    else if (!res.writableEnded) res.destroy();
  });

  req.on('error', (err) => {
    console.error(`[err] client ${err.message}`);
    proxyReq.destroy();
  });

  // Body size guard for chunked / no-content-length bodies.
  // Listener attached BEFORE pipe so no chunk is missed.
  // On overflow: unpipe (stop forwarding), drain the socket, send 413 cleanly.
  let received = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      aborted = true;
      console.error(`[err] payload too large (${received} > ${MAX_BODY_BYTES})`);
      req.unpipe(proxyReq);
      proxyReq.destroy();
      req.resume(); // drain without forwarding
      sendJson(413, { error: 'payload_too_large', limit: MAX_BODY_BYTES, received });
    }
  });

  // Client hung up (e.g. harness cancelled the request): kill the upstream
  // request so it stops burning quota generating output nobody will read.
  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

export function createProxyRoutes(config) {
  const proxy = new Hono();

  // Everything else goes through the raw byte-for-byte proxy. The proxy writes
  // directly to the Node ServerResponse, so return the adapter's already-sent
  // sentinel (must be the shared singleton: falsy body + pre-override global
  // Response, so the adapter skips writing its own response).
  proxy.all('*', (c) => {
    handleProxy(c.env.incoming, c.env.outgoing, config);
    return RESPONSE_ALREADY_SENT;
  });

  return proxy;
}
