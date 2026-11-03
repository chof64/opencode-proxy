import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { healthRoutes } from './routes/health.js';
import { createProxyRoutes } from './routes/proxy.js';

const clean = (v) => (v || '').replace(/[\r\n\t]/g, '').trim();

export function loadConfig(env = process.env, opts = {}) {
  const RAW_PORT = parseInt(env.PORT || '8080', 10);
  const PORT = Number.isInteger(RAW_PORT) ? RAW_PORT : 8080;
  const HOST = env.HOST || '127.0.0.1';
  // Upstream origin is fixed: paths are mirrored, so clients swap only the domain.
  // opts.upstreamOrigin exists only so tests can point at a local stub (no env knob).
  const UPSTREAM = new URL(opts.upstreamOrigin || 'https://opencode.ai');
  const TARGET_HOST = UPSTREAM.hostname;
  const TARGET_PORT = UPSTREAM.port ? parseInt(UPSTREAM.port, 10) : (UPSTREAM.protocol === 'http:' ? 80 : 443);
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
    upstreamRequest,
    MAX_BODY_BYTES,
    REQUEST_TIMEOUT_MS,
    OVERRIDE_KEY,
    SESSION_ID,
    USER_AGENT,
  };
}

export function createApp(config) {
  const app = new Hono();

  // Health first so local endpoints never reach the proxy.
  app.route('/', healthRoutes);
  // Router does the scoping: only the Go trees proxy through, path unchanged.
  app.route('/zen/go', createProxyRoutes(config));
  app.route('/inference/go', createProxyRoutes(config));
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return app;
}
