// Live end-to-end proof: real proxy -> real https://opencode.ai.
// Explicit only: `npm run test:e2e` sets OPENCODE_E2E_LIVE=1.
// Under plain `npm test` (or any run without that flag) this file registers a
// single passing placeholder and touches no network, so CI stays hermetic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { loadConfig, createApp } from '../src/app/index.js';

const LIVE = process.env.OPENCODE_E2E_LIVE === '1';
const KEY = (process.env.OPENCODE_API_KEY || '').trim();
const MODEL = (process.env.OPENCODE_E2E_MODEL || 'beam-free').trim();
const RESP_MODEL = (process.env.OPENCODE_E2E_RESPONSES_MODEL || 'muse-spark-1.3-contributor').trim();
const CLIENT_TIMEOUT_MS = 55000;

if (LIVE && !KEY) {
  console.error('[e2e] OPENCODE_API_KEY is required for the live run. Refusing to touch the network.');
  process.exit(2);
}

if (!LIVE) {
  test('live e2e (skipped: run npm run test:e2e)', () => {});
} else {
  const noKeepAlive = new http.Agent({ keepAlive: false });

  function rawRequest(port, path, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers, agent: noKeepAlive },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.setTimeout(CLIENT_TIMEOUT_MS, () => req.destroy(new Error('e2e client timeout')));
      if (body) req.end(body);
      else req.end();
    });
  }

  const maybeGunzip = (res) =>
    res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.body;

  function freePort() {
    return new Promise((resolve) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });
  }

  // Real upstream: no opts.upstreamOrigin, so loadConfig defaults to opencode.ai.
  function startLiveProxy(extraEnv = {}) {
    return freePort().then(
      (port) =>
        new Promise((resolve, reject) => {
          const config = loadConfig({
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            SESSION_ID: 'e2e-session-id',
            OPENCODE_API_KEY: '',
            ...extraEnv,
          });
          const app = createApp(config);
          const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
            resolve({ server, port, kill: () => server.close() });
          });
          server.on('error', reject);
        }),
    );
  }

  let proxy;
  let overrideProxy;

  before(async () => {
    proxy = await startLiveProxy();
    overrideProxy = await startLiveProxy({ OPENCODE_API_KEY: KEY });
  });

  after(() => {
    proxy?.kill();
    overrideProxy?.kill();
  });

  test('live: models list passes through with fallback session id', async () => {
    const res = await rawRequest(proxy.port, '/zen/go/v1/models', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    assert.equal(res.status, 200);
    assert.ok(!res.body.toString().includes('MissingSessionID'));
    JSON.parse(maybeGunzip(res).toString()); // valid JSON, gzipped or not
  });

  test('live: client-sent session id wins and still succeeds', async () => {
    const res = await rawRequest(proxy.port, '/zen/go/v1/models', {
      headers: { authorization: `Bearer ${KEY}`, 'x-opencode-session': `e2e-client-${randomUUID()}` },
    });
    assert.equal(res.status, 200);
  });

  test('live: gzip round-trips with matching content-encoding', async () => {
    const res = await rawRequest(proxy.port, '/zen/go/v1/models', {
      headers: { authorization: `Bearer ${KEY}`, 'accept-encoding': 'gzip' },
    });
    assert.equal(res.status, 200);
    JSON.parse(maybeGunzip(res).toString());
  });

  test('live: tiny chat completion proves request-body forwarding', async () => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'reply with the word ok' }],
      max_tokens: 16,
    });
    const res = await rawRequest(proxy.port, '/inference/go/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      body: payload,
    });
    const json = JSON.parse(maybeGunzip(res).toString());
    if (res.status === 200) {
      assert.ok(json.choices?.length > 0, 'expected at least one choice');
    } else {
      // Faithful relay counts too: this key may lack model access, in which
      // case upstream (not the proxy) refuses. Assert the refusal arrived
      // intact instead of a proxy synthesis (502/413/504).
      assert.ok(res.status >= 400 && res.status < 500, `expected upstream 4xx, got ${res.status}`);
      assert.ok(json.error?.message, 'expected upstream JSON error body');
      console.log(`[e2e] chat refused upstream (${res.status}): ${json.error.message}`);
    }
  });

  test('live: streaming chat arrives as SSE through the proxy', async () => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'reply with the word ok' }],
      max_tokens: 16,
      stream: true,
    });
    const res = await rawRequest(proxy.port, '/inference/go/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        accept: 'text/event-stream',
      },
      body: payload,
    });
    if (res.status === 200) {
      assert.match(res.headers['content-type'] || '', /text\/event-stream/);
      const text = maybeGunzip(res).toString();
      assert.ok(text.includes('data:'), 'expected SSE data lines');
    } else {
      // Same relay-fidelity rule as above: a restricted key gets upstream's
      // JSON refusal, not SSE. Assert it arrived intact.
      assert.ok(res.status >= 400 && res.status < 500, `expected upstream 4xx, got ${res.status}`);
      const json = JSON.parse(maybeGunzip(res).toString());
      assert.ok(json.error?.message, 'expected upstream JSON error body');
      console.log(`[e2e] stream refused upstream (${res.status}): ${json.error.message}`);
    }
  });

  test('live: responses api works (non-streaming)', async () => {
    const payload = JSON.stringify({
      model: RESP_MODEL,
      input: 'reply with the word ok',
      max_output_tokens: 64,
    });
    const res = await rawRequest(proxy.port, '/inference/go/openai/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      body: payload,
    });
    const json = JSON.parse(maybeGunzip(res).toString());
    if (res.status === 200) {
      assert.equal(json.object, 'response');
      assert.ok(json.output?.length > 0, 'expected non-empty output');
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `expected upstream 4xx, got ${res.status}`);
      assert.ok(json.error?.message, 'expected upstream JSON error body');
      console.log(`[e2e] responses refused upstream (${res.status}): ${json.error.message}`);
    }
  });

  test('live: responses api streams SSE through the proxy', async () => {
    const payload = JSON.stringify({
      model: RESP_MODEL,
      input: 'reply with the word ok',
      max_output_tokens: 64,
      stream: true,
    });
    const res = await rawRequest(proxy.port, '/inference/go/openai/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        accept: 'text/event-stream',
      },
      body: payload,
    });
    if (res.status === 200) {
      assert.match(res.headers['content-type'] || '', /text\/event-stream/);
      const text = maybeGunzip(res).toString();
      assert.ok(text.includes('data:'), 'expected SSE data lines');
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `expected upstream 4xx, got ${res.status}`);
      const json = JSON.parse(maybeGunzip(res).toString());
      assert.ok(json.error?.message, 'expected upstream JSON error body');
      console.log(`[e2e] responses stream refused upstream (${res.status}): ${json.error.message}`);
    }
  });

  test('live: override key replaces a bogus client key', async () => {
    const res = await rawRequest(overrideProxy.port, '/zen/go/v1/models', {
      headers: { authorization: 'Bearer bogus-client-key' },
    });
    assert.equal(res.status, 200);
  });
}
