// Entry point of the emergency executor (deploy/emergency/Dockerfile, target "executor"): serves the UI build
// (deploy/ui/server.mjs, unchanged policy: GET/HEAD, fixed file set, the app CSP) and the emergency API under
// <base>api/emergency/. It makes no outbound requests except to the Kubernetes API and, for sign-in, the configured
// OpenID Connect provider (security review H2).
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { checkBasePath, createHandler, loadHeaders, loadSite } from "../../ui/server.mjs";
import { createAdmissionCheck } from "./admission-check.ts";
import { createApi, MAX_SNAPSHOT_BODY, type ApiRequest } from "./api.ts";
import { createAuditLog } from "./audit.ts";
import { parseAuthConfig } from "./auth/config.ts";
import { createOidcProvider } from "./auth/oidc.ts";
import { createAuthStore } from "./auth/store.ts";
import { createBindingState, loadBindingsFile } from "./bindings.ts";
import { createInClusterKube } from "./kube.ts";
import { createNetworkCheck } from "./network-check.ts";
import { createStore } from "./store.ts";

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
};

const app = "/app";
const basePath = checkBasePath(process.env.GHA_UI_BASE_PATH ?? "/");
const site = loadSite(process.env.GHA_UI_STATIC_ROOT ?? join(app, "dist"));
const headers = loadHeaders(process.env.GHA_UI_HEADERS_FILE ?? join(app, "security-headers.json"));
const staticHandler = createHandler({ site, headers, basePath });

// Security review H2: who may sign in, how, and which executions need approval. Invalid configuration stops here.
const authConfig = parseAuthConfig(readFileSync(env("GHA_EMERGENCY_AUTH_FILE", "/etc/gha-emergency-auth/auth.json"), "utf8"));
const namespace = process.env.GHA_EMERGENCY_NAMESPACE ?? readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8").trim();
const dataDir = env("GHA_EMERGENCY_DATA_DIR", "/data");
const store = createStore(dataDir);
const audit = createAuditLog(dataDir);
const breakGlassFile = (account: string) => join(authConfig.breakGlass.credentialsDir, account);
const authStore = createAuthStore(dataDir, {
  sessionMaxHours: authConfig.sessions.maxHours,
  sessionIdleMinutes: authConfig.sessions.idleMinutes,
  breakGlassSessionMinutes: authConfig.sessions.breakGlassMinutes,
  initialAdministrators: authConfig.initialAdministrators,
  breakGlassAccounts: authConfig.breakGlass.accounts,
  breakGlassCredential: (account) => (existsSync(breakGlassFile(account)) ? readFileSync(breakGlassFile(account), "utf8").trim() : undefined),
});
const oidc = authConfig.oidc;
const provider = oidc
  ? createOidcProvider({ ...oidc, clientSecret: oidc.clientSecretFile ? () => readFileSync(oidc.clientSecretFile!, "utf8").trim() : undefined })
  : undefined;
if (!provider && !authConfig.breakGlass.accounts.length) console.log(JSON.stringify({ audit: true, action: "no-sign-in-configured", message: "Neither an OpenID Connect provider nor break-glass accounts are configured: nobody can sign in" }));
const hostPort = (value: string) => {
  const m = /^(.+):(\d+)$/.exec(value);
  if (!m) throw new Error(`Expected HOST:PORT, got ${JSON.stringify(value)}`);
  return { host: m[1]!, port: Number(m[2]) };
};
const runnerImage = env("GHA_EMERGENCY_RUNNER_IMAGE");
// Security review H4: a digest, never a tag that could be moved to other content. The admission policy pins the same.
if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(runnerImage)) throw new Error(`GHA_EMERGENCY_RUNNER_IMAGE must be an image reference by digest (repository@sha256:...), got ${JSON.stringify(runnerImage)}`);
const kube = createInClusterKube(namespace);
const executorPodLabels = JSON.parse(env("GHA_EMERGENCY_EXECUTOR_POD_LABELS")) as Record<string, string>;
const runnerServiceAccount = env("GHA_EMERGENCY_RUNNER_SERVICE_ACCOUNT");
const operatorSecret = env("GHA_EMERGENCY_OPERATOR_SECRET");
const allowEgress = process.env.GHA_EMERGENCY_ALLOW_EGRESS === "true";
const service = hostPort(env("GHA_EMERGENCY_SERVICE"));
const network = createNetworkCheck({
  kube,
  log: (e) => console.log(JSON.stringify({ audit: true, at: new Date().toISOString(), ...e })),
  config: {
    namespace,
    runnerImage,
    runnerServiceAccount,
    executorPodLabels,
    externalTarget: hostPort(env("GHA_EMERGENCY_CANARY_EXTERNAL", "1.1.1.1:443")),
    apiServer: { host: env("KUBERNETES_SERVICE_HOST"), port: Number(env("KUBERNETES_SERVICE_PORT", "443")) },
    metadataTarget: hostPort(env("GHA_EMERGENCY_CANARY_METADATA", "169.254.169.254:80")),
    // The executor's own Service, as an IP address: probes have no DNS.
    internalService: async () => ({ host: (await lookup(service.host, { family: 4 })).address, port: service.port }),
    egressEnabled: allowEgress,
    maxAgeMs: Number(env("GHA_EMERGENCY_NETWORK_CHECK_MAX_AGE_SECONDS", "900")) * 1000,
    retryMs: 30_000,
    timeoutMs: 90_000,
    pollMs: 2_000,
  },
});
const admission = createAdmissionCheck({
  kube,
  log: (e) => console.log(JSON.stringify({ audit: true, at: new Date().toISOString(), ...e })),
  config: { namespace, runnerImage, runnerServiceAccount, executorPodLabels, policyName: env("GHA_EMERGENCY_ADMISSION_POLICY"), maxAgeMs: 900_000, retryMs: 30_000 },
});
const bindingsFile = env("GHA_EMERGENCY_BINDINGS_FILE", "/etc/gha-emergency-bindings/bindings.json");
const api = createApi({
  network,
  admission,
  loadBindings: () => loadBindingsFile(bindingsFile, operatorSecret),
  bindingState: createBindingState(dataDir),
  auth: { store: authStore, provider, breakGlass: authConfig.breakGlass.accounts.length > 0 },
  audit,
  store,
  kube,
  config: {
    namespace,
    runnerImage,
    pvcName: env("GHA_EMERGENCY_PVC"),
    runnerServiceAccount,
    executorPodLabels,
    resources: { cpu: env("GHA_EMERGENCY_RUNNER_CPU", "1"), memory: env("GHA_EMERGENCY_RUNNER_MEMORY", "1Gi"), scratch: env("GHA_EMERGENCY_RUNNER_SCRATCH", "2Gi") },
    maxMinutes: Number(env("GHA_EMERGENCY_MAX_MINUTES", "60")),
    maxConcurrent: Number(env("GHA_EMERGENCY_MAX_CONCURRENT", "2")),
    ttlSecondsAfterFinished: Number(env("GHA_EMERGENCY_JOB_TTL_SECONDS", "86400")),
    operatorSecret,
    allowEgress,
    approval: authConfig.approval,
    uiBasePath: basePath,
  },
});
const startupBindings = loadBindingsFile(bindingsFile, operatorSecret);
if (startupBindings.problems.length) console.log(JSON.stringify({ audit: true, action: "secret-bindings-invalid", problems: startupBindings.problems }));
// Prove (or disprove) network isolation at startup; executions re-check when the result is older than its max age.
// The first check waits for this pod to become ready: the control canary connects to the executor's own Service.
setTimeout(() => void network.run().catch((e: Error) => console.log(JSON.stringify({ audit: true, action: "network-check-error", message: e.message }))), 20_000).unref();
void admission.run();
setInterval(() => authStore.purgeExpiredSessions(), 600_000).unref();
const removed = store.purgeExpired();
if (removed.length) console.log(JSON.stringify({ audit: true, action: "snapshots-expired", snapshots: removed }));

const apiPrefix = `${basePath}api/emergency/`;
const API_HEADERS = { ...headers.common, "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const path = url.split("?")[0]!;
  if (!path.startsWith(apiPrefix)) {
    const r = staticHandler(req.method, url);
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_SNAPSHOT_BODY) tooLarge = true;
    else chunks.push(c);
  });
  req.on("end", async () => {
    const send = (status: number, body: unknown, extra: Record<string, string | string[]> = {}) => {
      const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { ...API_HEADERS, ...extra, "Content-Length": String(data.length) });
      res.end(data);
    };
    if (tooLarge) return send(413, { error: "Request body too large" });
    const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : v);
    const request: ApiRequest = {
      method: req.method ?? "GET",
      path: path.slice(apiPrefix.length),
      query: new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : ""),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), single(v)])),
      body: Buffer.concat(chunks),
    };
    const r = await api(request);
    send(r.status, r.body, r.headers);
  });
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(Number(process.env.PORT ?? 8080), () => console.log(`gha-emergency-executor: UI and API under ${basePath} on port ${process.env.PORT ?? 8080}, namespace ${namespace}`));
const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
