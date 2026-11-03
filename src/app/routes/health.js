import { Hono } from 'hono';

export const healthRoutes = new Hono();

// Local health endpoints - never proxied, never touch upstream.
healthRoutes.all('/health', (c) => c.json({ status: 'ok' }));
healthRoutes.all('/healthz', (c) => c.json({ status: 'ok' }));
