# Images for emergency execution (docs/EMERGENCY_EXECUTION.md). Two targets from one build:
#
#   executor  the UI build served with the emergency API (deploy/emergency/executor/server.ts); talks only to the
#             Kubernetes API, never to GitHub
#   runner    runs one snapshot in a Kubernetes Job (deploy/emergency/runner/main.ts): Node.js 22, bash, sh, python3
#
#   podman build --ignorefile deploy/emergency/build.dockerignore -f deploy/emergency/Dockerfile --target executor -t gha-emergency-executor:local .
#   podman build --ignorefile deploy/emergency/build.dockerignore -f deploy/emergency/Dockerfile --target runner   -t gha-emergency-runner:local .
#
# The TypeScript sources run directly on Node's type stripping, so the images contain exactly the reviewed source.
# Base images are pinned by version tag, as for the UI image (deploy/ui/README.md).

FROM docker.io/library/node:22.23.4-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# The ordinary production UI build (no fixture mode), then only the files each image needs, in the repository layout.
RUN test -z "${GHA_UI_FIXTURES:-}" \
 && npm run build \
 && ! grep -rqF "__fixtures" dist \
 && mkdir -p /out/app/deploy/ui /out/app/deploy/emergency /out/app/src /out/app/node_modules \
 && cp -r dist /out/app/dist \
 && node deploy/ui/write-security-headers.ts /out/app/security-headers.json \
 && cp deploy/ui/server.mjs /out/app/deploy/ui/server.mjs \
 && cp -r deploy/emergency/executor deploy/emergency/runner /out/app/deploy/emergency/ \
 && cp -r src/emergency /out/app/src/emergency \
 && find /out/app -name "*.test.ts" -delete \
 && cp -r node_modules/yaml /out/app/node_modules/yaml \
 && printf '{"type":"module","private":true}\n' > /out/app/package.json

FROM docker.io/library/node:22.23.4-alpine3.24 AS executor
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /out/app/ /app/
ENV NODE_ENV=production PORT=8080 GHA_UI_BASE_PATH=/
USER 1000:1000
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/deploy/emergency/executor/server.ts"]

FROM docker.io/library/node:22.23.4-bookworm-slim AS runner
# python3 for Python steps and scripts (standard library only; nothing else is installed or installable offline).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Security review H3: an execute-only copy of node (root-owned, mode 0111) for the runner itself. Executing a binary
# the process can't read makes the kernel mark it non-dumpable, so workflow code running as the same user can't
# reach the runner through /proc (its stdout event channel, memory, environment). Workflow steps use the normal,
# readable /usr/local/bin/node. The runner refuses to start unless this protection is in effect (runner/main.ts).
RUN install -D -o root -g root -m 0111 /usr/local/bin/node /usr/local/libexec/gha-emergency-runner-node
WORKDIR /app
COPY --from=build /out/app/package.json /app/package.json
COPY --from=build /out/app/src/ /app/src/
COPY --from=build /out/app/deploy/emergency/runner/ /app/deploy/emergency/runner/
COPY --from=build /out/app/node_modules/ /app/node_modules/
USER 1000:1000
ENTRYPOINT ["/usr/local/libexec/gha-emergency-runner-node", "--disable-sigusr1", "--disable-warning=ExperimentalWarning", "/app/deploy/emergency/runner/main.ts"]
