// Security review H4: sends legitimate and malicious runner Jobs to a real API server where the gha-emergency chart is
// installed, and checks that the API server, not the executor, decides. Run it against a disposable cluster: it
// creates and deletes Jobs (and one Pod) in the release namespace, and with --negative-control it briefly removes and
// restores the policy binding and the namespace's dedicated label.
//
//   node --disable-warning=ExperimentalWarning tools/emergency/admission-check.ts --server https://127.0.0.1:16443 \
//     --token-file <admin token> [--ca <file> | --insecure] [--namespace gha-emergency] [--release gha-emergency] \
//     [--snapshot <digest bound to a Secret>] [--negative-control] [--pods] [--reproduce]
//
// The token must be a cluster administrator's: it reads the executor's Deployment and impersonates the executor's
// service account, so every Job is sent with exactly the executor's RBAC. The legitimate Jobs come from the real
// builders (deploy/emergency/executor/job-spec.ts), configured from the installed executor's own environment, so a
// policy that drifts from the builders fails here. --pods needs a running Job controller. Never prints the token.
// --reproduce shows the finding instead: with the binding removed, which malicious Jobs the executor's RBAC lets
// through, and which of their pods Pod Security "restricted" still admits (needs a Job controller); then it exits.
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { parseArgs } from "node:util";
import { createAdmissionCheck } from "../../deploy/emergency/executor/admission-check.ts";
import { buildCanaryJob, buildJob, type CanaryRole, type RunnerIsolation } from "../../deploy/emergency/executor/job-spec.ts";
import { KubeError, type KubeApi } from "../../deploy/emergency/executor/kube.ts";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- Kubernetes objects are untyped JSON here

const { values: args } = parseArgs({
  options: {
    server: { type: "string" },
    "token-file": { type: "string" },
    ca: { type: "string" },
    insecure: { type: "boolean", default: false },
    namespace: { type: "string", default: "gha-emergency" },
    release: { type: "string", default: "gha-emergency" },
    snapshot: { type: "string" },
    "negative-control": { type: "boolean", default: false },
    pods: { type: "boolean", default: false },
    reproduce: { type: "boolean", default: false },
  },
});
if (!args.server || !args["token-file"]) throw new Error("--server and --token-file are required");
const token = readFileSync(args["token-file"], "utf8").trim();
const ca = args.ca ? readFileSync(args.ca) : undefined;
const ns = args.namespace!;
// The chart's fullname (_helpers.tpl).
const full = args.release!.includes("gha-emergency") ? args.release! : `${args.release}-gha-emergency`;
const executorUser = `system:serviceaccount:${ns}:${full}-executor`;
const server = new URL(args.server);

type Res = { status: number; body: Obj };
function api(method: string, path: string, body?: unknown, as?: string): Promise<Res> {
  return new Promise((done, fail) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const contentType = method === "PATCH" ? "application/merge-patch+json" : "application/json";
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", ...(as ? { "Impersonate-User": as } : {}), ...(data ? { "Content-Type": contentType, "Content-Length": String(data.length) } : {}) };
    const req = request({ host: server.hostname, port: server.port || 443, method, path, ca, rejectUnauthorized: !args.insecure, timeout: 30_000, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: Obj;
        try {
          parsed = JSON.parse(text) as Obj;
        } catch {
          parsed = { message: text };
        }
        done({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on("error", fail);
    req.end(data);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A test API server's TLS handshake is occasionally slow under load: retry transport errors, never API answers. */
async function call(method: string, path: string, body?: unknown, as?: string): Promise<Res> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api(method, path, body, as);
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(2000);
    }
  }
}
const jobsPath = (namespace = ns) => `/apis/batch/v1/namespaces/${namespace}/jobs`;

// ---- the executor's configuration, as installed -------------------------------------------------------------------

const deployment = (await call("GET", `/apis/apps/v1/namespaces/${ns}/deployments/${full}-executor`)).body;
if (!deployment.spec) throw new Error(`Executor Deployment ${full}-executor not found in ${ns}: ${deployment.message}`);
const env = Object.fromEntries((deployment.spec.template.spec.containers[0].env as { name: string; value?: string }[]).map((e) => [e.name, e.value ?? ""]));
const bindings = JSON.parse((await call("GET", `/api/v1/namespaces/${ns}/configmaps/${full}-bindings`)).body.data["bindings.json"]) as { secret: string; keys: string[]; snapshots: string[] }[];
const policyName = env.GHA_EMERGENCY_ADMISSION_POLICY!;
const operatorSecret = env.GHA_EMERGENCY_OPERATOR_SECRET!;
const config = {
  namespace: ns,
  runnerImage: env.GHA_EMERGENCY_RUNNER_IMAGE!,
  pvcName: env.GHA_EMERGENCY_PVC!,
  serviceAccountName: env.GHA_EMERGENCY_RUNNER_SERVICE_ACCOUNT!,
  executorPodLabels: JSON.parse(env.GHA_EMERGENCY_EXECUTOR_POD_LABELS!) as Record<string, string>,
  isolation: JSON.parse(env.GHA_EMERGENCY_RUNNER_ISOLATION!) as RunnerIsolation,
  resources: { cpu: env.GHA_EMERGENCY_RUNNER_CPU!, memory: env.GHA_EMERGENCY_RUNNER_MEMORY!, scratch: env.GHA_EMERGENCY_RUNNER_SCRATCH! },
  maxMinutes: Number(env.GHA_EMERGENCY_MAX_MINUTES),
  ttlSecondsAfterFinished: Number(env.GHA_EMERGENCY_JOB_TTL_SECONDS),
};
const bound = bindings.find((b) => !args.snapshot || b.snapshots.includes(args.snapshot));
const boundSnapshot = args.snapshot ?? bound?.snapshots[0];
const unboundDigest = "0".repeat(63) + "1";
let seq = 0;
const nextId = () => `${Date.now().toString(16).slice(-8)}${(seq++).toString(16).padStart(8, "0")}`;

// Cloned: the builders share their securityContext objects between Jobs, and the cases below mutate them.
function execution(opts: { secret?: boolean } = {}): Obj {
  const snapshotId = opts.secret && boundSnapshot ? boundSnapshot : "a".repeat(64);
  const input = { ...config, executionId: nextId(), snapshotId, snapshotName: "admission check", snapshotVersion: 1, workflow: ".github/workflows/release.yml", inputs: {}, variables: {}, network: "isolated" as const, snapshotSubPath: `snapshots/${snapshotId}` };
  return structuredClone(buildJob({ ...input, secret: opts.secret && bound ? { name: bound.secret, keys: [bound.keys[0]!] } : undefined })) as Obj;
}
const canary = (role: CanaryRole): Obj =>
  structuredClone(buildCanaryJob({ checkId: nextId().slice(-8), role, targets: [{ name: "x", host: "10.0.0.1", port: 443 }], namespace: ns, runnerImage: config.runnerImage, serviceAccountName: config.serviceAccountName, executorPodLabels: config.executorPodLabels, isolation: config.isolation })) as Obj;
const pod = (j: Obj): Obj => j.spec.template.spec;
const ctr = (j: Obj): Obj => pod(j).containers[0];
const volume = (j: Obj, name: string): Obj => pod(j).volumes.find((v: Obj) => v.name === name);
const mount = (j: Obj, name: string): Obj => ctr(j).volumeMounts.find((m: Obj) => m.name === name);
const mutate = (j: Obj, f: (j: Obj) => void): Obj => {
  f(j);
  return j;
};

// ---- checks ---------------------------------------------------------------------------------------------------------

const results: { name: string; ok: boolean }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};
const deniedByPolicy = (r: Res) => (r.status === 403 || r.status === 422) && String(r.body.message).includes(`ValidatingAdmissionPolicy '${policyName}'`);
const brief = (r: Res) => `${r.status} ${String(r.body.message ?? "").replace(/^.*denied request: /, "") || r.body.kind}`;

async function expectAccepted(name: string, job: Obj) {
  const r = await call("POST", jobsPath(), job, executorUser);
  record(name, r.status === 201, brief(r));
  if (r.status === 201) await call("DELETE", `${jobsPath()}/${job.metadata.name}?propagationPolicy=Background`);
}

/** as: the identity to send it with; null for the administrator's own. */
async function expectDenied(name: string, job: Obj, as: string | null = executorUser) {
  const r = await call("POST", jobsPath(), job, as ?? undefined);
  const stored = await call("GET", `${jobsPath()}/${job.metadata.name}`);
  if (stored.status === 200) await call("DELETE", `${jobsPath()}/${job.metadata.name}?propagationPolicy=Background`);
  record(`refused: ${name}`, deniedByPolicy(r) && stored.status === 404, `${brief(r)} (stored: ${stored.status === 404 ? "no" : "YES"})`);
}

const privileged = (j: Obj) => {
  // allowPrivilegeEscalation false with privileged true is invalid before admission: ask for both, as an attacker would.
  ctr(j).securityContext.privileged = true;
  ctr(j).securityContext.allowPrivilegeEscalation = true;
};
const malicious: [string, (j: Obj) => void, boolean?][] = [
  ["privileged container", privileged],
  ["hostPath mount", (j) => (pod(j).volumes.push({ name: "host", hostPath: { path: "/" } }), ctr(j).volumeMounts.push({ name: "host", mountPath: "/host" }))],
  ["host networking", (j) => (pod(j).hostNetwork = true)],
  ["host PID namespace", (j) => (pod(j).hostPID = true)],
  ["host IPC namespace", (j) => (pod(j).hostIPC = true)],
  ["arbitrary Secret mount (the operator token)", (j) => (pod(j).volumes.push({ name: "secrets", secret: { secretName: operatorSecret, items: [{ key: "operator-token", path: "operator-token" }] } }), ctr(j).volumeMounts.push({ name: "secrets", mountPath: "/secrets", readOnly: true }))],
  ["whole bound Secret (no items)", (j) => delete volume(j, "secrets").secret.items, true],
  ["bound Secret, a key it doesn't grant", (j) => volume(j, "secrets").secret.items.push({ key: "OTHER_TEAM_TOKEN", path: "OTHER_TEAM_TOKEN" }), true],
  ["bound Secret, for a snapshot it isn't bound to", (j) => (mount(j, "snapshot").subPath = `snapshots/${unboundDigest}`), true],
  [
    "Secret environment variable",
    (j) => {
      const e = ctr(j).env.find((x: Obj) => x.name === "GHA_EMERGENCY_MAX_MINUTES");
      delete e.value;
      e.valueFrom = { secretKeyRef: { name: operatorSecret, key: "operator-token" } };
    },
  ],
  ["Secret envFrom", (j) => (ctr(j).envFrom = [{ secretRef: { name: operatorSecret } }])],
  ["service-account token mount (automount)", (j) => (pod(j).automountServiceAccountToken = true)],
  ["service-account token mount (projected volume)", (j) => (pod(j).volumes.push({ name: "token", projected: { sources: [{ serviceAccountToken: { path: "token" } }] } }), ctr(j).volumeMounts.push({ name: "token", mountPath: "/var/run/secrets/kubernetes.io/serviceaccount", readOnly: true }))],
  ["the executor's service account", (j) => (pod(j).serviceAccountName = `${full}-executor`)],
  ["alternate runner image (by digest)", (j) => (ctr(j).image = `docker.io/library/busybox@sha256:${"b".repeat(64)}`)],
  ["mutable image tag (the runner's own repository)", (j) => (ctr(j).image = config.runnerImage.replace(/@sha256:.*$/, ":local"))],
  ["image pull policy Always", (j) => (ctr(j).imagePullPolicy = "Always")],
  ["added sidecar", (j) => pod(j).containers.push({ ...structuredClone(ctr(j)), name: "sidecar" })],
  ["added init container", (j) => (pod(j).initContainers = [{ ...structuredClone(ctr(j)), name: "init" }])],
  ["privilege escalation", (j) => (ctr(j).securityContext.allowPrivilegeEscalation = true)],
  ["missing pod securityContext", (j) => delete pod(j).securityContext],
  ["missing container securityContext", (j) => delete ctr(j).securityContext],
  ["runs as root", (j) => (pod(j).securityContext.runAsUser = 0)],
  ["writable root filesystem", (j) => (ctr(j).securityContext.readOnlyRootFilesystem = false)],
  ["capability added (NET_ADMIN)", (j) => (ctr(j).securityContext.capabilities.add = ["NET_ADMIN"])],
  ["capabilities not dropped", (j) => (ctr(j).securityContext.capabilities = {})],
  ["seccomp Unconfined", (j) => (pod(j).securityContext.seccompProfile = { type: "Unconfined" })],
  ["excessive resource requests and limits", (j) => (ctr(j).resources = { requests: { cpu: "32", memory: "64Gi" }, limits: { cpu: "32", memory: "64Gi", "ephemeral-storage": "1Ti" } })],
  ["no resource limits", (j) => delete ctr(j).resources.limits],
  ["extended resource (GPU)", (j) => ((ctr(j).resources.limits["nvidia.com/gpu"] = "1"), (ctr(j).resources.requests["nvidia.com/gpu"] = "1"))],
  ["unbounded emptyDir", (j) => delete volume(j, "work").emptyDir.sizeLimit],
  ["memory-backed emptyDir", (j) => (volume(j, "work").emptyDir.medium = "Memory")],
  ["writable snapshot volume", (j) => ((volume(j, "snapshot").persistentVolumeClaim.readOnly = false), (mount(j, "snapshot").readOnly = false))],
  ["whole snapshot volume (no subPath)", (j) => delete mount(j, "snapshot").subPath],
  ["another PersistentVolumeClaim", (j) => (volume(j, "snapshot").persistentVolumeClaim.claimName = "someone-elses-data")],
  ["ConfigMap volume", (j) => (pod(j).volumes.push({ name: "cm", configMap: { name: `${full}-bindings` } }), ctr(j).volumeMounts.push({ name: "cm", mountPath: "/cm" }))],
  ["another command (sh -c)", (j) => (ctr(j).command = ["sh", "-c", "cat /secrets/*"])],
  ["extra arguments", (j) => (ctr(j).args = ["--inspect"])],
  ["unknown environment variable (NODE_OPTIONS)", (j) => ctr(j).env.push({ name: "NODE_OPTIONS", value: "--require /work/x.js" })],
  ["exec probe", (j) => (ctr(j).livenessProbe = { exec: { command: ["sh", "-c", "id"] } })],
  ["no runner labels (escapes the deny-all NetworkPolicy)", (j) => (j.spec.template.metadata.labels = { app: "x" })],
  ["egress network label while egress mode is off", (j) => (j.spec.template.metadata.labels["gha-emergency.github-actions-ui/network"] = "egress")],
  ["pinned to a node (nodeName)", (j) => (pod(j).nodeName = "control-plane")],
  ["toleration of every taint", (j) => (pod(j).tolerations = [{ operator: "Exists" }])],
  ["runtime class", (j) => (pod(j).runtimeClassName = "unconfined")],
  ["parallelism 20 (bypasses maxConcurrent)", (j) => ((j.spec.parallelism = 20), (j.spec.completions = 20))],
  ["retries (backoffLimit 6)", (j) => (j.spec.backoffLimit = 6)],
  ["no deadline", (j) => delete j.spec.activeDeadlineSeconds],
];
const bindingPath = `/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/${policyName}`;
/** Runs f with the policy's binding removed (a cluster without H4), then restores the binding. */
async function withoutBinding(f: () => Promise<void>) {
  const binding = (await call("GET", bindingPath)).body;
  await call("DELETE", bindingPath);
  try {
    // The API server drops the binding from its policy cache shortly after the delete.
    for (let i = 0; i < 10 && (await call("POST", `${jobsPath()}?dryRun=All`, mutate(execution(), privileged), executorUser)).status !== 201; i++) await sleep(1000);
    await f();
  } finally {
    const restored = await call("POST", "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings", { apiVersion: binding.apiVersion, kind: binding.kind, metadata: { name: binding.metadata.name, labels: binding.metadata.labels, annotations: binding.metadata.annotations }, spec: binding.spec });
    if (restored.status !== 201) console.log(`COULD NOT RESTORE THE BINDING: ${brief(restored)}`);
  }
}

const version = (await call("GET", "/version")).body;
console.log(`API server ${server.origin} (Kubernetes ${version.gitVersion}), namespace ${ns}, policy ${policyName}, as ${executorUser}\n`);

if (args.reproduce) {
  console.log("Reproduction: what the executor's RBAC allows without the admission policy (binding removed)\n");
  await withoutBinding(async () => {
    const sent: { name: string; job: Obj; status: number }[] = [];
    for (const [name, f, needsSecret] of malicious) {
      const job = mutate(execution({ secret: needsSecret }), f);
      sent.push({ name, job, status: (await call("POST", jobsPath(), job, executorUser)).status });
    }
    await sleep(20_000);
    for (const { name, job, status } of sent) {
      const pods = status === 201 ? ((await call("GET", `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${job.metadata.name}`)}`)).body.items ?? []) : [];
      console.log(`${status === 201 ? "Job accepted" : `refused ${status}`.padEnd(12)}  ${pods.length ? "pod admitted" : "no pod      "}  ${name}`);
      if (status === 201) await call("DELETE", `${jobsPath()}/${job.metadata.name}?propagationPolicy=Background`);
    }
  });
  process.exit(0);
}

console.log("Legitimate runner Jobs, exactly as the executor builds them (must be accepted):");
await expectAccepted("execution, isolated, no Secret", execution());
if (bound) await expectAccepted(`execution with bound Secret ${bound.secret} (${bound.keys[0]}) for its snapshot`, execution({ secret: true }));
else record("execution with a bound Secret", false, "no secretBindings installed: install the chart with one");
for (const role of ["probe-isolated", "control"] as const) await expectAccepted(`network canary ${role}`, canary(role));

console.log("\nMalicious Jobs (must be refused by the admission policy, and not stored):");
for (const [name, f, needsSecret] of malicious) {
  if (needsSecret && !bound) record(`refused: ${name}`, false, "needs a secretBinding");
  else await expectDenied(name, mutate(execution({ secret: needsSecret }), f));
}
await expectDenied("canary command with the snapshot mounted", mutate(canary("probe-isolated"), (j) => (pod(j).volumes.push({ name: "snapshot", persistentVolumeClaim: { claimName: config.pvcName, readOnly: true } }), ctr(j).volumeMounts.push({ name: "snapshot", mountPath: "/snapshot", subPath: `snapshots/${"a".repeat(64)}`, readOnly: true }))));
await expectDenied("canary control pod with a Secret", mutate(canary("control"), (j) => pod(j).volumes.push({ name: "secrets", secret: { secretName: bound?.secret ?? "x", items: [{ key: "k", path: "k" }] } })));
await expectDenied("a cluster administrator's privileged Job (the policy is not identity-based)", mutate(execution(), privileged), null);

console.log("\nOutside the policy (RBAC, unchanged):");
const job = execution();
{
  const other = await call("POST", jobsPath("default"), mutate(execution(), (j) => (j.metadata.namespace = "default")), executorUser);
  record("refused: Job in another namespace", other.status === 403 && /cannot create resource "jobs"/.test(String(other.body.message)), brief(other));
  const created = await call("POST", jobsPath(), job, executorUser);
  const patch = await call("PATCH", `${jobsPath()}/${job.metadata.name}`, { spec: { parallelism: 5 } }, executorUser);
  record("refused: executor changing a Job it created (no update or patch)", created.status === 201 && patch.status === 403, `${created.status} then ${brief(patch)}`);
  const direct = await call("POST", `/api/v1/namespaces/${ns}/pods`, { apiVersion: "v1", kind: "Pod", metadata: { name: "direct" }, spec: pod(execution()) }, executorUser);
  record("refused: executor creating a Pod directly", direct.status === 403, brief(direct));
}

if (args.pods) {
  console.log("\nPods (checked again after mutating admission):");
  let pods: Obj[] = [];
  const selector = encodeURIComponent(`gha-emergency.github-actions-ui/execution=${job.spec.template.metadata.labels["gha-emergency.github-actions-ui/execution"]}`);
  for (let i = 0; i < 30 && !pods.length; i++) {
    pods = (await call("GET", `/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`)).body.items ?? [];
    if (!pods.length) await sleep(1000);
  }
  record("the Job controller's pod for a legitimate Job is admitted (policy and Pod Security restricted)", pods.length === 1, `${pods.length} pod(s)`);
  const owner = (await call("GET", `${jobsPath()}/${job.metadata.name}`)).body;
  const spec = structuredClone(pod(job));
  spec.containers.push({ ...structuredClone(spec.containers[0]), name: "injected" });
  const name = `${job.metadata.name}-injected`;
  const injected = await call("POST", `/api/v1/namespaces/${ns}/pods`, { apiVersion: "v1", kind: "Pod", metadata: { name, labels: job.spec.template.metadata.labels, ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: owner.metadata.name, uid: owner.metadata.uid, controller: true }] }, spec });
  record("refused: Job-owned Pod with an injected sidecar that Pod Security restricted allows", deniedByPolicy(injected), brief(injected));
  if (injected.status === 201) await call("DELETE", `/api/v1/namespaces/${ns}/pods/${name}`);
}
await call("DELETE", `${jobsPath()}/${job.metadata.name}?propagationPolicy=Background`);

// The executor's own proof, through its real module, with the executor's identity.
const kube: KubeApi = {
  async createJob(j, options) {
    const r = await call("POST", `${jobsPath()}${options?.dryRun ? "?dryRun=All" : ""}`, j, executorUser);
    if (r.status < 200 || r.status >= 300) throw new KubeError(r.status, `Kubernetes API POST jobs returned ${r.status}: ${r.body.message}`);
  },
  getJob: async () => undefined,
  deleteJob: async () => {},
  listPods: async () => [],
  podLog: async () => "",
  podWarnings: async () => [],
};
const check = () => createAdmissionCheck({ kube, config: { namespace: ns, runnerImage: config.runnerImage, runnerServiceAccount: config.serviceAccountName, executorPodLabels: config.executorPodLabels, isolation: config.isolation, policyName, maxAgeMs: 0, retryMs: 0 } }).run();
console.log("\nThe executor's admission check (deploy/emergency/executor/admission-check.ts):");
{
  const r = await check();
  record(`reports "enforced"`, r.state === "enforced", `${r.state}: ${r.reason}`);
}

if (args["negative-control"]) {
  console.log("\nNegative controls (installed is not enforced):");
  const nsPath = `/api/v1/namespaces/${ns}`;
  const label = "gha-emergency.github-actions-ui/dedicated";
  await call("PATCH", nsPath, { metadata: { labels: { [label]: null } } });
  try {
    const undedicated = await call("POST", jobsPath(), execution(), executorUser);
    record("refused: a legitimate Job once the namespace loses its dedicated label", deniedByPolicy(undedicated), brief(undedicated));
    const r = await check();
    record(`the executor's check is not "enforced" then`, r.state !== "enforced", `${r.state}: ${r.reason}`);
  } finally {
    await call("PATCH", nsPath, { metadata: { labels: { [label]: "true" } } });
  }

  await withoutBinding(async () => {
    const dry = await call("POST", `${jobsPath()}?dryRun=All`, mutate(execution(), privileged), executorUser);
    record("without the binding, the privileged Job is accepted (dry run): the policy, not RBAC or Pod Security, was refusing it", dry.status === 201, brief(dry));
    const r = await check();
    record(`the executor's check reports "not-enforced" without the binding`, r.state === "not-enforced", `${r.state}: ${r.reason}`);
  });
  let r = await check();
  for (let i = 0; i < 10 && r.state !== "enforced"; i++) {
    await sleep(1000);
    r = await check();
  }
  record(`the executor's check reports "enforced" again once the binding is restored`, r.state === "enforced", `${r.state}: ${r.reason}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
