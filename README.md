# OpenCode Warp Proxy

Local HTTP proxy that injects the `x-opencode-session` header so [Warp](https://www.warp.dev/) can use your [OpenCode Go](https://opencode.ai/docs/go/) subscription.

OpenCode Go rejects requests without that header:

```
400 Bad Request {"type":"MissingSessionID","message":"Request is missing x-opencode-session..."}
```

This proxy listens on `127.0.0.1:8080`, receives Warp's requests, and forwards them to `https://opencode.ai/zen/go/v1/...` with the required headers injected.

## Requirements

- Docker + Docker Compose
- An OpenCode Go API key from <https://opencode.ai/auth>
- Warp terminal with a custom OpenAI-compatible AI provider

## Quick start

### 1. Start the proxy

```bash
cd ~/opencode-warp-proxy
docker compose up -d --build
```

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

All configuration is via environment variables. Copy the example file and edit:

```bash
cp .env.example .env
```

### Auth modes

| Mode | How it works | When to use |
|------|--------------|-------------|
| **Pass-through** (default) | Warp sends `Authorization: Bearer <key>`. Proxy forwards it unchanged. | Recommended. Configure your real key in Warp. |
| **Override** | Set `OPENCODE_API_KEY` in `.env`. Proxy replaces the client's auth header. | If you don't want your real key in Warp's config files. |

### Optional settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port (change both this and the host mapping in `docker-compose.yml`). |
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
- Container runs as non-root `node` user with `no-new-privileges`, `read_only` rootfs, and `tmpfs` for `/tmp`.
- Local `/health` endpoint is never proxied (used by Docker healthcheck, doesn't burn upstream quota).
- Body size and request timeouts are enforced to bound resource use.
- To expose on a LAN: don't. Use Tailscale, WireGuard, or an SSH tunnel instead.

## Troubleshooting

### `400 MissingSessionID` still appears

- Restart Warp after changing the AI provider.
- Base URL must end with `/v1` (no trailing slash).
- `docker compose logs -f` should show `[req] POST /v1/chat/completions -> ...`. If you only see requests without the `/v1/` prefix, your Warp base URL is wrong.

### `Connection refused` from Warp

- On macOS / Windows Docker, use `http://host.docker.internal:8080/v1`.
- On Linux, add to `docker-compose.yml` under the service:
  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```

### `curl http://127.0.0.1:8080/v1/models` works, Warp does not

Warp might cache the AI provider settings. Restart it fully (Cmd+Q / kill the process).

### Streaming / hanging responses

The proxy forwards `Content-Type` and streaming headers verbatim. If Warp hangs, check that the model you picked supports streaming (most do).

### Inspect proxy traffic

```bash
docker compose logs -f
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
  --security-opt no-new-privileges:true \
  --read-only --tmpfs /tmp:size=10m \
  overlag/opencode-warp-proxy:latest
```

### Build, tag and push your own

The repo includes a `Makefile` for the full workflow:

```bash
make login     # docker login -u overlag (one-time, interactive)
make publish   # build + tag + push :1.0.0 and :latest
```

Manual equivalent:

```bash
docker compose build
docker tag opencode-warp-proxy:local overlag/opencode-warp-proxy:1.0.0
docker tag opencode-warp-proxy:local overlag/opencode-warp-proxy:latest
docker push overlag/opencode-warp-proxy:1.0.0
docker push overlag/opencode-warp-proxy:latest
```

Tags: `:latest` for everyday use, `:1.0.0` (or next semver) for reproducibility. Override with `make tag TAG=1.2.3 push TAG=1.2.3`.

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
make login                  # once
make publish TAG=1.1.0      # multi-arch build + push :1.1.0 and :latest
make verify                 # confirm both platforms present in manifest
```

The build context is filtered by `.dockerignore` (excludes `.git`, `.env*`, `*.md`, `docker-compose.yml`, etc.) so secrets in `.env` never leak into the image, and only `package.json` + `server.js` are sent to the daemon.

## License

MIT
