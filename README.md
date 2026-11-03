# OpenCode Warp Proxy

Local HTTP proxy that injects the `x-opencode-session` header so [Warp](https://www.warp.dev/) can use your [OpenCode Go](https://opencode.ai/docs/go/) subscription.

OpenCode Go rejects requests without that header:

```
400 Bad Request {"type":"MissingSessionID","message":"Request is missing x-opencode-session..."}
```

This proxy listens on `127.0.0.1:8080`, receives Warp's requests, and forwards them to `https://opencode.ai/zen/go/v1/...` with the required headers injected.

## Requirements

- Docker
- An OpenCode Go API key from <https://opencode.ai/auth>
- Warp terminal with a custom OpenAI-compatible AI provider

## Quick start

### 1. Start the proxy

Pull and run the published image:

```bash
docker run -d --name opencode-warp-proxy --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e SESSION_ID=your-stable-id \
  overlag/opencode-warp-proxy:latest
```

Or build locally:

```bash
docker build -t opencode-warp-proxy:local .
docker run -d --name opencode-warp-proxy --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  opencode-warp-proxy:local
```

The container listens on `0.0.0.0` and respects `$PORT`, so hosting platforms can inject their own port. Locally, `-p 127.0.0.1:8080:8080` keeps it on loopback.

Verify it works:

```bash
curl http://127.0.0.1:8080/v1/models
```

You should get the list of available Go models as JSON.

### 2. Configure Warp

In **Warp > Settings > AI > AI Provider**:

| Field | Value |
|-------|-------|
| Provider | OpenAI-compatible (custom) |
| Base URL | `http://localhost:8080/v1` |
| API key | Your OpenCode Go API key |

On macOS / Windows Docker, the host is `http://host.docker.internal:8080/v1`.

Pick any model from the OpenCode Go catalog (e.g. `glm-5.3-flash`, `kimi-k3`, `qwen3.8-flash`).

### 3. Test

Open Warp AI and send a prompt. The `400 MissingSessionID` error should be gone.

## Configuration

All configuration is via environment variables, passed with `docker run -e` flags or set on your hosting platform. `.env.example` lists every variable as a reference.

### Auth modes

| Mode | How it works | When to use |
|------|--------------|-------------|
| **Pass-through** (default) | Warp sends `Authorization: Bearer <key>`. Proxy forwards it unchanged. | Recommended. Configure your real key in Warp. |
| **Override** | Pass `-e OPENCODE_API_KEY=...` to `docker run`. Proxy replaces the client's auth header. | If you don't want your real key in Warp's config files. |

### Optional settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port (match the container port in `-p` when you change this). |
| `SESSION_ID` | random UUID | Pin a stable id to keep prompt caching across proxy restarts. |
| `USER_AGENT` | `opencode-warp-proxy/1.0` | Must identify as a coding agent. Generic SDK UAs are blocked. |
| `MAX_BODY_BYTES` | `10485760` | Max request body size. Larger payloads get 413. |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout for both client and upstream. |
| `UPSTREAM_BASE` | `https://opencode.ai/zen/go` | Upstream base URL. Only needed for tests. |

## How it works

```
Warp  --HTTP-->  127.0.0.1:8080  --HTTPS-->  opencode.ai/zen/go/v1/...
                          |
                          +-- rewrites path:        /v1/*  ->  /zen/go/v1/*
                          +-- injects headers:
                                x-opencode-session: <stable uuid>
                                user-agent:         <custom>
                                authorization:      <pass-through or override>
```

Streaming (SSE) passes through transparently - request and response bodies are piped unmodified.

## Security

- Proxy binds `127.0.0.1:8080` only. No LAN exposure by default.
- No proxy-level auth: anyone with localhost access already has the host.
- API key is never logged. Session id is logged once at startup.
- Container runs as non-root `node` user. Image includes a `HEALTHCHECK` on `/health`.
- Local `/health` endpoint is never proxied (used by Docker healthcheck, doesn't burn upstream quota).
- Body size and request timeouts are enforced to bound resource use.
- To expose on a LAN: don't. Use Tailscale, WireGuard, or an SSH tunnel instead.

## Troubleshooting

### `400 MissingSessionID` still appears

- Restart Warp after changing the AI provider.
- Base URL must end with `/v1` (no trailing slash).
- `docker logs -f opencode-warp-proxy` should show `[req] POST /v1/chat/completions -> ...`. If you only see requests without the `/v1/` prefix, your Warp base URL is wrong.

### `Connection refused` from Warp

- On macOS / Windows Docker, use `http://host.docker.internal:8080/v1`.
- On Linux, add `--add-host host.docker.internal:host-gateway` to `docker run`.

### `curl http://127.0.0.1:8080/v1/models` works, Warp does not

Warp might cache the AI provider settings. Restart it fully (Cmd+Q / kill the process).

### Streaming / hanging responses

The proxy forwards `Content-Type` and streaming headers verbatim. If Warp hangs, check that the model you picked supports streaming (most do).

### Inspect proxy traffic

```bash
docker logs -f opencode-warp-proxy
```

Every request is logged: `[req] METHOD /path -> https://opencode.ai/zen/go/path`.

## Development

Run without Docker:

```bash
npm install   # no dependencies, but creates node_modules/.bin
npm start
```

Run the tests (spawns the proxy against a local stub, no network needed):

```bash
npm test
```

Or with watch mode:

```bash
npm run dev
```

Requires Node 24 or later.

## Publishing to Docker Hub

The image is published as [`overlag/opencode-warp-proxy`](https://hub.docker.com/r/overlag/opencode-warp-proxy).

### Pull and run

```bash
docker run -d --name opencode-warp-proxy --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  overlag/opencode-warp-proxy:latest
```

### Build, tag and push your own

```bash
docker login
docker buildx build --platform linux/amd64,linux/arm64 \
  -t overlag/opencode-warp-proxy:1.0.0 \
  -t overlag/opencode-warp-proxy:latest \
  --push .
```

Tags: `:latest` for everyday use, `:1.0.0` (or next semver) for reproducibility.

### Image details

- Base: `node:24-alpine`
- Size: ~170 MB per arch
- Architecture: `linux/amd64`, `linux/arm64` (multi-arch manifest, auto-selected per host)
- Entrypoint: `node server.js`
- Exposed port: `8080`

If you get `platform does not match` errors, force-pull the right arch:

```bash
docker pull --platform linux/arm64 overlag/opencode-warp-proxy:1.0.0
```

### Releasing a new version

```bash
docker login
docker buildx build --platform linux/amd64,linux/arm64 \
  -t overlag/opencode-warp-proxy:1.1.0 \
  -t overlag/opencode-warp-proxy:latest \
  --push .
docker buildx imagetools inspect overlag/opencode-warp-proxy:1.1.0
```

The build context is filtered by `.dockerignore` (excludes `.git`, `.env*`, `*.md`, etc.) so secrets in `.env` never leak into the image, and only `package.json` + `server.js` are sent to the daemon.

## License

MIT
