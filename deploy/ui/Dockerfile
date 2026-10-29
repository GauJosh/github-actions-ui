# Production image for the GitHub Actions UI: the static production build, served by deploy/ui/server.mjs (Node
# built-ins only). The browser calls api.github.com itself; the server makes no outbound requests.
#
#   docker build -f deploy/ui/Dockerfile -t gha-ui:local .
#   docker run --rm -p 8080:8080 --read-only --cap-drop=ALL --security-opt=no-new-privileges gha-ui:local
#
# One image serves at a host's root (default) or under a path prefix: -e GHA_UI_BASE_PATH=/gha-ui/
# Base images are pinned by version tag, not by digest (deploy/ui/README.md).

FROM docker.io/library/node:22.23.4-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# The ordinary production build (`npm run build`): GHA_UI_FIXTURES is never set, so fixture mode is compiled out
# (tests/unit/build-boundary.test.ts). The grep is a last guard against shipping a fixture-enabled build.
RUN test -z "${GHA_UI_FIXTURES:-}" \
 && npm run build \
 && ! grep -rqF "__fixtures" dist \
 && mkdir /out \
 && cp -r dist /out/dist \
 && cp deploy/ui/server.mjs /out/server.mjs \
 && node deploy/ui/write-security-headers.ts /out/security-headers.json

FROM docker.io/library/node:22.23.4-alpine3.24
# Only node runs here: no package managers.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# Owned by root and not writable by the runtime user; nothing is written at runtime.
COPY --from=build /out/ /app/
ENV NODE_ENV=production \
    PORT=8080 \
    GHA_UI_BASE_PATH=/
# The image's unprivileged "node" user, by number so that Kubernetes runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080
STOPSIGNAL SIGTERM
# Node directly as PID 1, without the base image's shell entrypoint; the server handles SIGTERM itself.
ENTRYPOINT ["node", "/app/server.mjs"]
CMD []
