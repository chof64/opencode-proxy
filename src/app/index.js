import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';

const clean = (v) => (v || '').replace(/[\r\n\t]/g, '').trim();

export function loadConfig(env = process.env) {
  const RAW_PORT = parseInt(env.PORT || '8080', 10);
  const PORT = Number.isInteger(RAW_PORT) ? RAW_PORT : 8080;
  const HOST = env.HOST || '127.0.0.1';
  // Upstream base. Overridable via env so tests can point at a local stub.
  const UPSTREAM = new URL(env.UPSTREAM_BASE || 'https://opencode.ai/zen/go');
  const TARGET_HOST = UPSTREAM.hostname;
  const TARGET_PORT = UPSTREAM.port ? parseInt(UPSTREAM.port, 10) : (UPSTREAM.protocol === 'http:' ? 80 : 443);
  const TARGET_PREFIX = UPSTREAM.pathname.replace(/\/+$/, '');
  const upstreamRequest = UPSTREAM.protocol === 'http:' ? http.request : https.request;
  const MAX_BODY_BYTES = parseInt(env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
  const REQUEST_TIMEOUT_MS = parseInt(env.REQUEST_TIMEOUT_MS || '60000', 10);

  const OVERRIDE_KEY = clean(env.OPENCODE_API_KEY) || null;
  const SESSION_ID = clean(env.SESSION_ID) || randomUUID();
  const USER_AGENT = clean(env.USER_AGENT) || 'chof64/opencode-proxy/1.0';

  return {
    PORT,
    HOST,
    UPSTREAM,
    TARGET_HOST,
    TARGET_PORT,
    TARGET_PREFIX,
    upstreamRequest,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    OVERRIDE_KEY,
    SESSION_ID,
    USER_AGENT,
  };
}

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

export function handleProxy(req, res, config) {
  const {
    TARGET_HOST,
    TARGET_PORT,
    TARGET_PREFIX,
    upstreamRequest,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    OVERRIDE_KEY,
    SESSION_ID,
    USER_AGENT,
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
}

export function createApp(config) {
  const app = new Hono();

  // Local health endpoints - never proxied, never touch upstream.
  app.all('/health', (c) => c.json({ status: 'ok' }));
  app.all('/healthz', (c) => c.json({ status: 'ok' }));

  // Everything else goes through the raw byte-for-byte proxy. The proxy writes
  // directly to the Node ServerResponse, so return the adapter's already-sent
  // sentinel (must be the shared singleton: falsy body + pre-override global
  // Response, so the adapter skips writing its own response).
  app.all('*', (c) => {
    handleProxy(c.env.incoming, c.env.outgoing, config);
    return RESPONSE_ALREADY_SENT;
  });

  return app;
}
