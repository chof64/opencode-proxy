# opencode-proxy

> Forked from [arepresas/opencode-warp-proxy](https://github.com/arepresas/opencode-warp-proxy). This fork is maintained independently as `chof64/opencode-proxy` and does not track upstream — new work follows this repo's own needs.

Local HTTP proxy that adds the `x-opencode-session` header so any OpenAI-compatible harness can use your [OpenCode Go](https://opencode.ai/docs/go/) subscription.

OpenCode Go rejects requests without that header:

```
400 Bad Request {"type":"MissingSessionID","message":"Request is missing x-opencode-session..."}
```

This proxy listens on `127.0.0.1:8080`, receives client requests, and forwards them to `https://opencode.ai` with the path unchanged and the required headers injected.

## Requirements

- Docker
- An OpenCode Go API key from <https://opencode.ai/auth>
- Any OpenAI-compatible AI harness (e.g. Warp terminal with a custom provider)

## Quick start

### 1. Start the proxy

Pull and run the published image:

```bash
docker run -d --name opencode-proxy --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e SESSION_ID=your-stable-id \
  ghcr.io/chof64/opencode-proxy:latest
```

Or build locally:

```bash
docker build -t opencode-proxy:local .
docker run -d --name opencode-proxy --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e SESSION_ID=your-stable-id \
  opencode-proxy:local
```

The container listens on `0.0.0.0` and respects `$PORT`, so hosting platforms can inject their own port. Locally, `-p 127.0.0.1:8080:8080` keeps it on loopback. If you omit `-e SESSION_ID`, the proxy generates a random UUID at each startup (logged as `[boot] session:`) and upstream prompt caching resets on restart.

Verify it works:

```bash
curl http://127.0.0.1:8080/zen/go/v1/models
```

You should get the list of available Go models as JSON.

### 2. Configure your harness (example: Warp)

In **Warp > Settings > AI > AI Provider** (or your harness's equivalent custom-provider setting):

| Field | Value |
|-------|-------|
| Provider | OpenAI-compatible (custom) |
| Base URL | `http://localhost:8080/zen/go/v1` |
| API key | Your OpenCode Go API key |

On macOS / Windows Docker, the host is `http://host.docker.internal:8080/zen/go/v1`. Prefer the inference endpoint instead with `http://localhost:8080/inference/go/openai/v1` (swap only the domain: `opencode.ai/...` becomes `localhost:8080/...`).

> Breaking change: legacy `/v1` paths (e.g. `http://localhost:8080/v1`) now return 404. Update your Base URL to one of the mirrored paths above.

Pick any model from the OpenCode Go catalog (e.g. `glm-5.3-flash`, `kimi-k3`, `qwen3.8-flash`).

### 3. Test

Send a prompt from your harness. The `400 MissingSessionID` error should be gone.

## Configuration

All configuration is via environment variables, passed with `docker run -e` flags or set on your hosting platform. `.env.example` lists every variable as a reference.

### Auth modes

| Mode | How it works | When to use |
|------|--------------|-------------|
| **Pass-through** (default) | The harness sends `Authorization: Bearer <key>`. Proxy forwards it unchanged. | Recommended. Configure your real key in the harness. |
| **Override** | Pass `-e OPENCODE_API_KEY=...` to `docker run`. Proxy replaces the client's auth header. | If you don't want your real key in harness config files. |

### Optional settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port (match the container port in `-p` when you change this). |
| `SESSION_ID` | random UUID | Pin a stable id to keep prompt caching across proxy restarts. |
| `USER_AGENT` | `chof64/opencode-proxy/1.0` | Must identify as a coding agent. Generic SDK UAs are blocked. |
| `MAX_BODY_BYTES` | `10485760` | Max request body size. Larger payloads get 413. |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout for both client and upstream. |

## How it works

```
Client --HTTP--> 127.0.0.1:8080  --HTTPS--> opencode.ai (same path)
                          |
                          +-- mirrors path:         /zen/go/v1/*       ->  /zen/go/v1/*
                                                    /inference/go/*     ->  /inference/go/*
                          +-- rejects anything else with 404
                          +-- injects headers:
                                x-opencode-session: <stable uuid>
                                user-agent:         <custom>
                                authorization:      <pass-through or override>
```

Streaming (SSE) passes through transparently - request and response bodies are piped unmodified.

## Security

- Container listens on `0.0.0.0` inside the image; loopback-only on the host comes from publishing as `-p 127.0.0.1:8080:8080`. A bare `-p 8080:8080` exposes it on the LAN.
- No proxy-level auth: anyone with localhost access already has the host.
- API key is never logged. Session id is logged once at startup.
- Container runs as non-root `node` user. Image includes a `HEALTHCHECK` on `/health`.
- Local `/health` endpoint is never proxied (used by Docker healthcheck, doesn't burn upstream quota).
- Body size and request timeouts are enforced to bound resource use.
- To expose on a LAN: don't. Use Tailscale, WireGuard, or an SSH tunnel instead.

## Troubleshooting

### `400 MissingSessionID` still appears

- Restart your harness after changing the AI provider.
- Base URL must be a full mirrored path ending in `/v1` with no trailing slash (e.g. `http://localhost:8080/zen/go/v1` or `http://localhost:8080/inference/go/openai/v1`).
- `docker logs -f opencode-proxy` should show `[req] POST /zen/go/v1/chat/completions -> https://opencode.ai/zen/go/v1/chat/completions`. If requests 404, your base URL is not a mirrored Go path.

### `Connection refused` from your harness

- On macOS / Windows Docker, use `http://host.docker.internal:8080/zen/go/v1` (or `.../inference/go/openai/v1`).
- On Linux, add `--add-host host.docker.internal:host-gateway` to `docker run`.

### `curl http://127.0.0.1:8080/zen/go/v1/models` works, the harness does not

Your harness might cache the AI provider settings. Restart it fully.

### Streaming / hanging responses

The proxy forwards status, headers, and streaming bodies verbatim. If requests hang, check that the model you picked supports streaming (most do).

### Inspect proxy traffic

```bash
docker logs -f opencode-proxy
```

Every request is logged: `[req] METHOD /zen/go/v1/... -> https://opencode.ai/zen/go/v1/...` (path mirrored).

## Live end-to-end (manual)

`npm run test:e2e` drives the real proxy against real `https://opencode.ai` using
your `OPENCODE_API_KEY` (plus optional `OPENCODE_E2E_MODEL`, default
`beam-free`, and `OPENCODE_E2E_RESPONSES_MODEL`, default
`muse-spark-1.3-contributor`). It spends a tiny amount of quota on short chat,
streamed chat, and Responses API calls, so run it on demand only. Without the key it exits before
touching the network, and plain `npm test` never runs it (CI stays hermetic).

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

## Publishing to GHCR

The image is published as [`ghcr.io/chof64/opencode-proxy`](https://github.com/chof64/opencode-proxy/pkgs/container/opencode-proxy).

### Pull and run

```bash
docker run -d --name opencode-proxy --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e SESSION_ID=your-stable-id \
  ghcr.io/chof64/opencode-proxy:latest
```

### Automated (preferred)

Merge a conventional commit to `main` and one release run versions, tags (`v*`), creates the GitHub Release, and publishes the GHCR image — never tag or push manually:

| Commit | Release |
|--------|---------|
| `fix:` | patch |
| `feat:` | minor |
| `BREAKING CHANGE:` footer | major |

Non-releasing pushes skip the publish steps. [`.github/workflows/docker.yml`](.github/workflows/docker.yml) is verification-only (PR builds, never pushes); all `main`-push testing and all publishes happen in [`.github/workflows/release.yml`](.github/workflows/release.yml).

### Local build (no push)

All publishes go through GitHub Actions — never push images manually, so every tag is built identically from a `v*` tag. For local verification only:

```bash
docker build -t opencode-proxy:local .
```

Tags: `:latest` for everyday use, `:1.0.0` (or next semver) for reproducibility.

### Image details

- Base: `node:24-alpine`
- Size: ~170 MB per arch
- Architecture: `linux/amd64`, `linux/arm64` (multi-arch manifest, auto-selected per host)
- Entrypoint: `node src/server.js`
- Exposed port: `8080`

If you get `platform does not match` errors, force-pull the right arch:

```bash
docker pull --platform linux/arm64 ghcr.io/chof64/opencode-proxy:1.0.0
```

### Releasing a new version

Just merge to `main` using conventional commits (`fix:`, `feat:`, or a `BREAKING CHANGE:` footer). Verify after merge:

```bash
docker buildx imagetools inspect ghcr.io/chof64/opencode-proxy:1.1.0
```

The build context is filtered by `.dockerignore` (excludes `.git`, `.env*`, `*.md`, test files, CI config, etc.) so secrets in `.env` never leak into the image, and the image copies only `package.json` + `src/`.

## License

MIT — see [LICENSE](./LICENSE). Upstream credit: [arepresas/opencode-warp-proxy](https://github.com/arepresas/opencode-warp-proxy).
