# UI container

The production image for the GitHub Actions UI: the static production build served by `server.mjs`, a small server built on Node's `node:http` module. It has no framework, backend or runtime dependencies.

The browser calls `https://api.github.com` directly, as in local use: the personal access token stays in the tab's memory. The server never sees, stores or forwards it, and it makes no outbound requests.

## Build and run

```sh
docker build -f deploy/ui/Dockerfile -t gha-ui:local .
docker run --rm -p 8080:8080 --read-only --cap-drop=ALL --security-opt=no-new-privileges gha-ui:local
```

Podman accepts the same commands. Its `--read-only` adds writable tmpfs mounts unless you also pass `--read-only-tmpfs=false`; the server does not need them.

`gha-ui:local` is only an example tag for running the image directly. The Helm chart expects `localhost/gha-ui:k1` by default. To deploy, build under that name; [`charts/gha-ui/README.md`](../../charts/gha-ui/README.md) has the Podman and Docker steps for Minikube.

No image is published to a registry.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listening port. `0` picks a free port, used by tests. |
| `GHA_UI_BASE_PATH` | `/` | Path prefix the UI is served under, such as `/gha-ui/`. Must start and end with `/`. |
| `GHA_UI_STATIC_ROOT` | `/app/dist` | The build output. |
| `GHA_UI_HEADERS_FILE` | `/app/security-headers.json` | The headers to send, generated at image build time. |

**Root and path-prefix hosting.** One image serves both.

- The build references its assets and the log worker relative to the page (`base: "./"` in `vite.config.ts`). Routes live in the URL hash, so no path depends on where the page is served.
- Under a prefix, the bare prefix (`/gha-ui`) redirects to `/gha-ui/`. Other paths outside the prefix return 404.
- A proxy that strips the prefix before forwarding can use the default `/` instead.

## Behaviour

- **Security headers:**
  - every response gets the app CSP, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`;
  - the log worker script (`assets/log-worker-*.js`) gets the worker CSP (`connect-src 'none'`) instead of the app CSP.
- **Single source for the headers:** the values come from `tools/vite/security-headers.ts`, the same source `vite preview` uses. `write-security-headers.ts` turns them into `security-headers.json` at image build time. `check-http.ts` compares what a running server actually sends with that source.
- **Caching:** `index.html` is `no-cache`. Hashed files in `assets/` are cached for a year as `immutable`.
- **Health check:** `GET /healthz` returns `200 ok` at the root, whatever the prefix. It touches neither GitHub nor the filesystem.
- **Methods:** GET and HEAD only; other methods get 405.
- **What gets served:**
  - only files of the build, read into memory at startup and matched by their exact path;
  - no request path is decoded or resolved against the filesystem;
  - unknown paths return 404, with no fallback page;
  - fixture routes are never served, and the build contains no fixture code (`tests/unit/build-boundary.test.ts`).

## Checks

```sh
node deploy/ui/check-http.ts http://127.0.0.1:8080 /          # or /gha-ui/ for a prefixed server
GHA_UI_ROOT_URL=http://127.0.0.1:8081/ GHA_UI_SUBPATH_URL=http://127.0.0.1:8082/gha-ui/ \
  npx playwright test tests/e2e/static-server.spec.ts         # the app in a browser against running containers
```

In Git Bash on Windows, prefix these with `MSYS_NO_PATHCONV=1`. Otherwise Git Bash rewrites `/` and `/gha-ui/` arguments into Windows paths, and `check-http.ts` rejects them as invalid base paths.

Without those variables, `tests/e2e/static-server.spec.ts` builds the production bundle and starts `server.mjs` itself, once at the root and once under `/gha-ui/`. `tests/unit/static-server.test.ts` covers the request policy without sockets.

## Base images

Both stages use the official `node` image pinned by version tag:
- build: `22.23.4-bookworm-slim`;
- runtime: `22.23.4-alpine3.24`, with npm, npx, corepack and yarn removed.

Tags are not immutable. They are not pinned by digest yet, because no digest has been verified for every platform the image may be built for. On 2026-10-28, a linux/amd64 pull resolved them to the digests below. Pin by digest, or verify these, before relying on reproducible builds.

- `node:22.23.4-bookworm-slim`: `sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`
- `node:22.23.4-alpine3.24`: `sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`
