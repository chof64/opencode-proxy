import { serve } from '@hono/node-server';
import { loadConfig, createApp } from './app/index.js';

const config = loadConfig();
const app = createApp(config);
const { PORT, HOST, UPSTREAM, TARGET_PREFIX, OVERRIDE_KEY, SESSION_ID, USER_AGENT, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS } = config;

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
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
