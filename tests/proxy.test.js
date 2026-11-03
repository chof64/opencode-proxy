import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import net from 'node:net';
import { serve } from '@hono/node-server';
import { loadConfig, createApp } from '../src/app/index.js';

// Local stub standing in for opencode.ai. Records what the proxy forwards.
const seen = [];
let stubMode = 'identity'; // or 'gzip': compress anyway, like a CDN that ignores negotiation
let stub;
let stubPort;

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// Fresh socket per request: reusing a pooled socket across tests would mask real
// connection handling and couple tests through the agent's pool.
const noKeepAlive = new http.Agent({ keepAlive: false });

function clientGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: noKeepAlive }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function clientPost(port, path, json, headers = {}) {
  const body = typeof json === 'string' ? json : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
        agent: noKeepAlive,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// In-process proxy: config is built with loadConfig (stub origin injected via
// opts, no env knob) and served directly. No subprocess, no network needed.
function startProxy(extraEnv = {}) {
  return freePort().then(
    (port) =>
      new Promise((resolve, reject) => {
        let config;
        try {
          config = loadConfig(
            {
              ...process.env,
              PORT: String(port),
              HOST: '127.0.0.1',
              SESSION_ID: 'test-session-id',
              OPENCODE_API_KEY: '',
              ...extraEnv,
            },
            { upstreamOrigin: `http://127.0.0.1:${stubPort}` },
          );
        } catch (err) {
          reject(err);
          return;
        }
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
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      if (stubMode === 'gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(JSON.stringify({ ok: true, mode: 'gzip' })));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;
  proxy = await startProxy();
  overrideProxy = await startProxy({ OPENCODE_API_KEY: 'override-key' });
});

after(() => {
  proxy?.kill();
  overrideProxy?.kill();
  return new Promise((r) => stub.close(r));
});

test('mirrors zen path, injects session id, passes auth through', async () => {
  seen.length = 0;
  const res = await clientGet(proxy.port, '/zen/go/v1/models', {
    'accept-encoding': 'gzip, br', // every real client sends this
    authorization: 'Bearer client-key',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString()), { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/zen/go/v1/models');
  assert.equal(seen[0].headers['x-opencode-session'], 'test-session-id');
  assert.equal(seen[0].headers.authorization, 'Bearer client-key');
  assert.ok(!('accept-encoding' in seen[0].headers), 'proxy must not negotiate compression upstream');
});

test('mirrors inference paths unchanged, query included', async () => {
  seen.length = 0;
  const payload = { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] };
  const res = await clientPost(proxy.port, '/inference/go/openai/v1/chat/completions', payload, {
    authorization: 'Bearer client-key',
  });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/inference/go/openai/v1/chat/completions');
  assert.deepEqual(JSON.parse(seen[0].body), payload);

  seen.length = 0;
  const models = await clientGet(proxy.port, '/inference/go/v1/models?foo=bar');
  assert.equal(models.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/inference/go/v1/models?foo=bar');
});

test('override key replaces client auth', async () => {
  seen.length = 0;
  await clientGet(overrideProxy.port, '/zen/go/v1/models', { authorization: 'Bearer client-key' });
  assert.equal(seen[0].headers.authorization, 'Bearer override-key');
});

test('upstream reply arrives intact, compressed or not', async () => {
  stubMode = 'gzip';
  try {
    const res = await clientGet(proxy.port, '/zen/go/v1/models', { 'accept-encoding': 'gzip, br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString()), { ok: true, mode: 'gzip' });
  } finally {
    stubMode = 'identity';
  }
});

test('oversized declared body gets 413 without touching upstream', async () => {
  seen.length = 0;
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, path: '/zen/go/v1/chat/completions', method: 'POST', headers: { 'content-length': String(11 * 1024 * 1024) } },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 413);
  assert.equal(JSON.parse(res.body).error, 'payload_too_large');
  assert.equal(seen.length, 0);
});

test('non-Go paths 404 without touching upstream', async () => {
  for (const path of ['/v1/models', '/v1/chat/completions', '/', '/oops']) {
    seen.length = 0;
    const res = await clientGet(proxy.port, path);
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body.toString()).error, 'not_found');
    assert.equal(seen.length, 0);
  }
});

test('health never touches upstream', async () => {
  seen.length = 0;
  const res = await clientGet(proxy.port, '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString()), { status: 'ok' });
  assert.equal(seen.length, 0);
});

test('healthz mirrors health, never touches upstream', async () => {
  seen.length = 0;
  const res = await clientGet(proxy.port, '/healthz');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(res.body.toString()), { status: 'ok' });
  assert.equal(seen.length, 0);
});

test('health with query string stays local (Hono path match)', async () => {
  seen.length = 0;
  for (const path of ['/health?x=1', '/healthz?x=1']) {
    const res = await clientGet(proxy.port, path);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body.toString()), { status: 'ok' });
  }
  assert.equal(seen.length, 0);
});

test('health answers any method; trailing slash is not health', async () => {
  seen.length = 0;
  const postRes = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, path: '/health', method: 'POST', agent: noKeepAlive },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(postRes.status, 200);
  assert.deepEqual(JSON.parse(postRes.body), { status: 'ok' });
  assert.equal(seen.length, 0);

  seen.length = 0;
  const slashRes = await clientGet(proxy.port, '/health/');
  assert.equal(slashRes.status, 404);
  assert.equal(seen.length, 0);
});

test('malformed target gets single 4xx without touching upstream', async () => {
  seen.length = 0;
  const raw = await new Promise((resolve, reject) => {
    let data = '';
    const sock = net.connect(proxy.port, '127.0.0.1', () => {
      sock.write('GET /zen/go/v1/mo dels HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    sock.on('data', (c) => {
      data += c.toString();
    });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 4\d\d/);
  assert.equal(seen.length, 0);
});
