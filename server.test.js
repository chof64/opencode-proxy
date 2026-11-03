import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function startProxy(extraEnv = {}) {
  return freePort().then(
    (port) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
          env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            SESSION_ID: 'test-session-id',
            UPSTREAM_BASE: `http://127.0.0.1:${stubPort}/zen/go`,
            OPENCODE_API_KEY: '',
            ...extraEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const kill = () => child.kill();
        const timer = setTimeout(() => {
          kill();
          reject(new Error('proxy did not boot in time'));
        }, 8000);
        child.stdout.on('data', (d) => {
          if (d.toString().includes('[boot] listening')) {
            clearTimeout(timer);
            resolve({ child, port, kill });
          }
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
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
  proxy.kill();
  overrideProxy.kill();
  return new Promise((r) => stub.close(r));
});

test('rewrites path, injects session id, passes auth through', async () => {
  seen.length = 0;
  const res = await clientGet(proxy.port, '/v1/models', {
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

test('override key replaces client auth', async () => {
  seen.length = 0;
  await clientGet(overrideProxy.port, '/v1/models', { authorization: 'Bearer client-key' });
  assert.equal(seen[0].headers.authorization, 'Bearer override-key');
});

test('upstream reply arrives intact, compressed or not', async () => {
  stubMode = 'gzip';
  try {
    const res = await clientGet(proxy.port, '/v1/models', { 'accept-encoding': 'gzip, br' });
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
      { host: '127.0.0.1', port: proxy.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-length': String(11 * 1024 * 1024) } },
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

test('health never touches upstream', async () => {
  seen.length = 0;
  const res = await clientGet(proxy.port, '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString()), { status: 'ok' });
  assert.equal(seen.length, 0);
});
