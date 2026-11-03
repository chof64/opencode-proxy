import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const RAW_PORT = parseInt(process.env.PORT || '8080', 10);
const PORT = Number.isInteger(RAW_PORT) ? RAW_PORT : 8080;
const HOST = process.env.HOST || '127.0.0.1';
// Upstream base. Overridable via env so tests can point at a local stub.
const UPSTREAM = new URL(process.env.UPSTREAM_BASE || 'https://opencode.ai/zen/go');
const TARGET_HOST = UPSTREAM.hostname;
const TARGET_PORT = UPSTREAM.port ? parseInt(UPSTREAM.port, 10) : (UPSTREAM.protocol === 'http:' ? 80 : 443);
const TARGET_PREFIX = UPSTREAM.pathname.replace(/\/+$/, '');
const upstreamRequest = UPSTREAM.protocol === 'http:' ? http.request : https.request;
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10);

const clean = (v) => (v || '').replace(/[\r\n\t]/g, '').trim();
const OVERRIDE_KEY = clean(process.env.OPENCODE_API_KEY) || null;
const SESSION_ID = clean(process.env.SESSION_ID) || randomUUID();
const USER_AGENT = clean(process.env.USER_AGENT) || 'opencode-warp-proxy/1.0';

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
  'content-length',
]);

const server = http.createServer((req, res) => {
  // Local health endpoint - never proxied, never touches upstream.
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }

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
  const targetPath = `${TARGET_PREFIX}${incomingPath.startsWith('/') ? incomingPath : '/' + incomingPath}`;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers[key] = value;
    }
  }

  // Never ask upstream for compression: bodies are piped through byte-for-byte,
  // so a gzipped reply would reach the client flagged as plain JSON. Force identity.
  delete headers['accept-encoding'];

  headers.host = TARGET_HOST;
  headers['user-agent'] = USER_AGENT;
  headers['x-opencode-session'] = SESSION_ID;

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
    const outHeaders = { ...proxyRes.headers };
    delete outHeaders['transfer-encoding'];
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

  // Client hung up (e.g. Warp "stop" pressed): kill the upstream request so it
  // stops burning quota generating output nobody will read.
  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy();
  });

  req.pipe(proxyReq);
});

server.listen(PORT, HOST, () => {
  const mode = OVERRIDE_KEY ? 'override (env OPENCODE_API_KEY)' : 'pass-through (from client)';
  console.log(`[boot] listening on http://${HOST}:${PORT}`);
  console.log(`[boot] target: ${UPSTREAM.origin}${TARGET_PREFIX}/v1`);
  console.log(`[boot] session: ${SESSION_ID}`);
  console.log(`[boot] user-agent: ${USER_AGENT}`);
  console.log(`[boot] auth: ${mode}`);
  console.log(`[boot] limits: body=${MAX_BODY_BYTES}B timeout=${REQUEST_TIMEOUT_MS}ms`);
});

const shutdown = (signal) => {
  console.log(`[shutdown] ${signal} received`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
