/* eslint-disable @typescript-eslint/no-explicit-any -- API response bodies are asserted structurally. */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admissionProbes, createAdmissionCheck, type AdmissionCheck, type AdmissionChecker } from "../../deploy/emergency/executor/admission-check.ts";
import { createApi, LOGIN_COOKIE, SESSION_COOKIE, type ApiRequest, type ApiResponse, type ApprovalPolicy } from "../../deploy/emergency/executor/api.ts";
import { createAuditLog } from "../../deploy/emergency/executor/audit.ts";
import { createOidcProvider } from "../../deploy/emergency/executor/auth/oidc.ts";
import type { Role } from "../../deploy/emergency/executor/auth/roles.ts";
import { createAuthStore, oidcUserId } from "../../deploy/emergency/executor/auth/store.ts";
import { createBindingState, parseBindings, type SecretBinding } from "../../deploy/emergency/executor/bindings.ts";
import { buildCanaryJob, buildJob, GITHUB_HOSTS, NETWORK_LABEL, placement, RUNNER_NODE, RUNNER_POD_LABELS, RunnerIsolationError, type CanaryTarget, type RunnerIsolation } from "../../deploy/emergency/executor/job-spec.ts";
import { KubeError, type K8sJob, type K8sPod, type KubeApi } from "../../deploy/emergency/executor/kube.ts";
import { createNetworkCheck, type NetworkCheck, type NetworkChecker } from "../../deploy/emergency/executor/network-check.ts";
import { createStore } from "../../deploy/emergency/executor/store.ts";
import { ed25519EventSigner, eventSigner } from "../../src/emergency/event-stream.ts";
import { CANARY_PREFIX, EVENT_PREFIX } from "../../src/emergency/events.ts";
import { createMemoryReader } from "../../src/emergency/memory-reader.ts";
import { prepareSnapshot } from "../../src/emergency/prepare.ts";
import { toBase64, type SnapshotBundle } from "../../src/emergency/snapshot.ts";
import { DEMO_REPO, demoRepos } from "../../tools/emergency/demo-repos.ts";
import { createDevIdp } from "../../tools/emergency/dev-oidc.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-10-30T12:00:00Z");
/** The executor's clock, also the identity provider's and the session store's; tests move it forward. */
let clock = NOW;
const now = () => clock;
// Security review H2: users sign in through an OpenID Connect provider (a development provider, in process). Their
// roles are assigned in the executor's records, never taken from the token; "root" is a pinned initial administrator.
const ISS = "https://idp.example.test";
const CLIENT = "gha-emergency";
const REDIRECT = "https://gha.example.test/api/emergency/auth/callback";
const ROLE_OF: Record<string, Role[]> = { alice: ["operator"], bob: ["operator"], carol: ["approver"], erin: ["approver"], dave: ["viewer"], mallory: [], root: [] };
const IDP = createDevIdp({ issuer: ISS, clientId: CLIENT, redirectUri: REDIRECT, users: Object.keys(ROLE_OF).map((sub) => ({ sub, name: sub, email: `${sub}@example.test` })), now });
const BREAK_GLASS: Record<string, string> = { "recovery-1": "r1-credential-0123456789abcdef0123456789abcdef", "recovery-2": "r2-credential-0123456789abcdef0123456789abcdef" };
/** The value a response sets for a cookie, from its Set-Cookie headers. */
const setCookie = (r: ApiResponse, name: string) => [r.headers?.["Set-Cookie"] ?? []].flat().map((c) => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find((v) => v !== undefined);
const WORKFLOW = ".github/workflows/release.yml";
const OPERATOR_SECRET = "gha-emergency-operator";

async function bundle(changes: Record<string, string> = {}, expiresInDays = 7, repoName = DEMO_REPO): Promise<SnapshotBundle> {
  const repos = demoRepos(root);
  Object.assign(repos[DEMO_REPO]!.files, changes);
  if (repoName !== DEMO_REPO) {
    repos[repoName] = repos[DEMO_REPO]!;
    delete repos[DEMO_REPO];
    const { manifest, contents } = await prepareSnapshot(createMemoryReader(repos), { repository: repoName, ref: "main", workflows: [WORKFLOW], name: "release demo", expiresInDays }, NOW);
    return { manifest, contents: Object.fromEntries([...contents].map(([k, v]) => [k, toBase64(v)])) };
  }
  const { manifest, contents } = await prepareSnapshot(createMemoryReader(repos), { repository: DEMO_REPO, ref: "main", workflows: [WORKFLOW], name: "release demo", expiresInDays }, NOW);
  return { manifest, contents: Object.fromEntries([...contents].map(([k, v]) => [k, toBase64(v)])) };
}

function fakeKube() {
  let podPhase = "Running";
  /** The runner container's exit code by execution id, once it has terminated. */
  const exitCodes = new Map<string, number>();
  const jobs = new Map<string, { spec: Record<string, unknown>; status: K8sJob["status"] }>();
  const logs = new Map<string, string>();
  const warnings: string[] = [];
  const kube: KubeApi = {
    async createJob(job) {
      const name = (job as { metadata: { name: string } }).metadata.name;
      jobs.set(name, { spec: job as Record<string, unknown>, status: { active: 1 } });
    },
    async getJob(name) {
      const j = jobs.get(name);
      return j ? { metadata: { name }, status: j.status } : undefined;
    },
    async deleteJob(name) {
      jobs.delete(name);
    },
    async listPods(selector): Promise<K8sPod[]> {
      const id = selector.split("=")[1]!;
      const exitCode = exitCodes.get(id);
      const containerStatuses = exitCode === undefined ? undefined : [{ name: "runner", state: { terminated: { exitCode } } }];
      return jobs.has(`gha-emergency-${id}`) ? [{ metadata: { name: `pod-${id}` }, status: { phase: podPhase, containerStatuses } }] : [];
    },
    async podLog(pod) {
      return logs.get(pod.slice(4)) ?? "";
    },
    async podWarnings() {
      return warnings;
    },
  };
  return { kube, jobs, logs, warnings, exitCodes, setPhase: (phase: string) => (podPhase = phase) };
}

/** A network checker that reports a fixed verdict (the canary itself is tested below). */
function stubNetwork(state: NetworkCheck["state"], egress?: NetworkCheck["egress"]) {
  const result: NetworkCheck = { state, checkedAt: NOW.toISOString(), reason: `stub: ${state}`, isolated: [], control: [], egress };
  const calls = { ensureFresh: 0 };
  const checker = {
    status: () => result,
    run: async () => result,
    ensureFresh: async () => {
      calls.ensureFresh++;
      return result;
    },
  } as NetworkChecker;
  return { checker, calls };
}

/** An admission checker that reports a fixed verdict (the check itself is tested below). */
function stubAdmission(state: AdmissionCheck["state"]) {
  const result: AdmissionCheck = { state, checkedAt: NOW.toISOString(), reason: `stub admission: ${state}` };
  const calls = { ensureFresh: 0 };
  const checker = {
    status: () => result,
    run: async () => result,
    ensureFresh: async () => {
      calls.ensureFresh++;
      return result;
    },
  } as AdmissionChecker;
  return { checker, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gha-emergency-api-"));
  clock = NOW;
});
afterEach(() => {
  const unlock = (d: string) => {
    chmodSync(d, 0o755);
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) unlock(join(d, e.name));
      else chmodSync(join(d, e.name), 0o644);
    }
  };
  if (existsSync(dir)) unlock(dir);
  rmSync(dir, { recursive: true, force: true });
});

/** Before H2's approval tests, executions need no approval unless a test asks for the policy. */
const NO_APPROVAL: ApprovalPolicy = { requireFor: [], separationOfDuties: true, ttlMinutes: 60 };
type SetupOptions = { maxConcurrent?: number; network?: NetworkCheck["state"]; egress?: NetworkCheck["egress"]; allowEgress?: boolean; bindingsJson?: string; admission?: AdmissionCheck["state"]; approval?: ApprovalPolicy };

async function setup(opts: SetupOptions = {}) {
  const data = join(dir, "data");
  const store = createStore(data);
  const k = fakeKube();
  const audit: Record<string, unknown>[] = [];
  const bindings: SecretBinding[] = [];
  const net = stubNetwork(opts.network ?? "enforced", opts.egress);
  const adm = stubAdmission(opts.admission ?? "enforced");
  const authStore = createAuthStore(
    data,
    {
      sessionMaxHours: 8,
      sessionIdleMinutes: 60,
      breakGlassSessionMinutes: 60,
      initialAdministrators: [{ issuer: ISS, subject: "root" }],
      breakGlassAccounts: [
        { name: "recovery-1", roles: ["operator"] },
        { name: "recovery-2", roles: ["approver"] },
      ],
      breakGlassCredential: (a) => BREAK_GLASS[a],
    },
    now,
  );
  const provider = createOidcProvider({ issuer: ISS, clientId: CLIENT, redirectUri: REDIRECT }, { fetch: IDP.fetch, now });
  const bindingState = createBindingState(data);
  const api = createApi({
    store,
    kube: k.kube,
    now,
    network: net.checker,
    admission: adm.checker,
    loadBindings: () => (opts.bindingsJson !== undefined ? parseBindings(opts.bindingsJson, OPERATOR_SECRET) : { bindings, problems: [] }),
    bindingState,
    auth: { store: authStore, provider, breakGlass: true },
    audit: createAuditLog(data, { now, stdout: (line) => audit.push(JSON.parse(line) as Record<string, unknown>) }),
    config: {
      namespace: "gha-emergency",
      runnerImage: "gha-emergency-runner:test",
      pvcName: "gha-emergency-data",
      runnerServiceAccount: "gha-emergency-runner",
      executorPodLabels: { "app.kubernetes.io/name": "gha-emergency-executor" },
      isolation: { mode: "colocated" as const },
      resources: { cpu: "1", memory: "1Gi", scratch: "2Gi" },
      maxMinutes: 30,
      maxConcurrent: opts.maxConcurrent ?? 2,
      ttlSecondsAfterFinished: 3600,
      operatorSecret: OPERATOR_SECRET,
      allowEgress: opts.allowEgress ?? false,
      approval: opts.approval ?? NO_APPROVAL,
      uiBasePath: "/",
    },
  });

  /** The whole sign-in, as a browser does it: the executor's redirect, the provider, the callback. Returns the session cookie. */
  async function signIn(sub: string): Promise<string> {
    const login = await api({ method: "GET", path: "auth/login", query: new URLSearchParams({ return: "#/emergency" }), headers: {} });
    const binding = setCookie(login, LOGIN_COOKIE)!;
    const query = await IDP.authorize(String(login.headers!.Location), sub);
    const back = await api({ method: "GET", path: "auth/callback", query, headers: { cookie: `${LOGIN_COOKIE}=${binding}` } });
    const session = setCookie(back, SESSION_COOKIE);
    if (!session) throw new Error(`sign-in failed: ${String(back.headers?.Location)}`);
    return session;
  }
  const sessions = new Map<string, string>();
  /** A signed-in user's session; the first sign-in also gives the user their fixture roles (as an administrator would). */
  async function sessionOf(sub: string): Promise<string> {
    if (!sessions.has(sub)) {
      sessions.set(sub, await signIn(sub));
      if (ROLE_OF[sub]!.length) authStore.setRoles(oidcUserId(ISS, sub), ROLE_OF[sub]!, "test-fixture");
    }
    return sessions.get(sub)!;
  }
  /** An API call from the page of a signed-in user (alice, an operator, by default), or anonymous (null). */
  const call = async (method: string, path: string, body?: unknown, as: string | null = "alice", headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers?: ApiResponse["headers"] }> => {
    const cookie = as ? `${SESSION_COOKIE}=${await sessionOf(as)}` : undefined;
    const r: ApiRequest = { method, path, headers: { "x-gha-emergency": "1", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)) };
    const res = await api(r);
    return { status: res.status, body: res.body as any, headers: res.headers };
  };
  /** Stores the demo snapshot and binds demo-secrets (DEMO_SIGNING_KEY) to it, as an administrator would. */
  const boundDemo = async (changes: Record<string, string> = {}) => {
    const id = (await call("POST", "snapshots", await bundle(changes))).body.snapshot.id as string;
    bindings.push({ name: "release-demo", secret: "demo-secrets", keys: ["DEMO_SIGNING_KEY"], snapshots: [id] });
    return id;
  };
  return { store, call, audit, bindings, boundDemo, net, adm, api, authStore, bindingState, signIn, sessionOf, ...k };
}

const run = (id: string, extra: Record<string, unknown> = {}) => ({ snapshotId: id, workflow: WORKFLOW, inputs: { version: "1" }, ...extra });

describe("executor API: snapshots", () => {
  it("stores a verified snapshot write-once; the same content is the same snapshot, a change is a new version", async () => {
    const { call, store } = await setup();
    const first = await call("POST", "snapshots", await bundle());
    expect(first.status).toBe(201);
    expect(first.body.snapshot).toMatchObject({ name: "release demo", version: 1, executable: true, source: { repository: DEMO_REPO } });
    expect((await call("POST", "snapshots", await bundle())).body).toMatchObject({ created: false, snapshot: { id: first.body.snapshot.id, version: 1 } });
    const second = await call("POST", "snapshots", await bundle({ "src/app/main.txt": "v2\n" }));
    expect(second.body.snapshot).toMatchObject({ version: 2 });
    expect(second.body.snapshot.id).not.toBe(first.body.snapshot.id);
    expect(store.get(first.body.snapshot.id)!.manifest.files.find((f) => f.path === "src/app/main.txt")!.size).not.toBe(3);
    expect((await call("POST", `snapshots/${first.body.snapshot.id}/verify`, {})).body).toEqual({ ok: true, problems: [] });
  });

  it("rejects tampered or incomplete uploads", async () => {
    const { call } = await setup();
    const b = await bundle();
    const key = Object.keys(b.contents)[0]!;
    const tampered = { ...b, contents: { ...b.contents, [key]: toBase64(new TextEncoder().encode("evil")) } };
    const r = await call("POST", "snapshots", tampered);
    expect(r.status).toBe(422);
    expect(r.body.details.map((d: { code: string }) => d.code)).toContain("content-mismatch");
    const missing = { ...b, contents: Object.fromEntries(Object.entries(b.contents).slice(1)) };
    expect((await call("POST", "snapshots", missing)).status).toBe(422);
  });

  it("detects a stored file changed on the volume", async () => {
    const { call, store, boundDemo } = await setup();
    const id = await boundDemo();
    const f = join(store.dataDir, store.subPath(id), "files", "workspace", "scripts", "build.sh");
    chmodSync(join(store.dataDir, store.subPath(id), "files", "workspace", "scripts"), 0o755);
    chmodSync(f, 0o644);
    writeFileSync(f, "echo changed\n");
    expect((await call("POST", `snapshots/${id}/verify`, {})).body.ok).toBe(false);
    expect((await call("POST", "executions", run(id))).status).toBe(409);
  });

  it("shows which Secret, if any, is bound to a snapshot", async () => {
    const { call, boundDemo } = await setup();
    const id = await boundDemo();
    expect((await call("GET", `snapshots/${id}`)).body).toMatchObject({ secretBinding: { name: "release-demo", secret: "demo-secrets", keys: ["DEMO_SIGNING_KEY"] }, allowEgress: false });
  });
});

describe("executor API: executions", () => {
  it("validates the request against the snapshot's requirements", async () => {
    const { call, boundDemo } = await setup();
    const id = await boundDemo();
    const r = await call("POST", "executions", { snapshotId: id, workflow: WORKFLOW, inputs: { nope: "x" }, network: "internet" });
    expect(r.status).toBe(422);
    expect(r.body.details.join("\n")).toMatch(/Input nope is not declared[\s\S]*network must be "isolated" or "egress"/);
    expect((await call("POST", "executions", { snapshotId: id, workflow: ".github/workflows/build.yml" })).status).toBe(422);
  });

  it("creates a locked-down Job that mounts only the bound Secret's required keys and carries no values", async () => {
    const { call, jobs, audit, boundDemo } = await setup();
    const id = await boundDemo();
    const r = await call("POST", "executions", run(id, { inputs: { version: "3.1.0" }, network: "isolated" }));
    expect(r.status).toBe(201);
    expect(r.body.execution).toMatchObject({ secretName: "demo-secrets", secretKeys: ["DEMO_SIGNING_KEY"], network: "isolated", isolation: { state: "enforced" } });
    const job = [...jobs.values()][0]!.spec as any;
    const pod = job.spec.template.spec;
    const c = pod.containers[0];
    expect(pod.volumes.find((v: any) => v.name === "secrets").secret).toEqual({ secretName: "demo-secrets", defaultMode: 0o440, optional: false, items: [{ key: "DEMO_SIGNING_KEY", path: "DEMO_SIGNING_KEY" }] });
    expect(c.volumeMounts.find((m: any) => m.name === "snapshot")).toEqual({ name: "snapshot", mountPath: "/snapshot", subPath: `snapshots/${id}`, readOnly: true });
    expect(JSON.parse(c.env.find((e: any) => e.name === "GHA_EMERGENCY_EXECUTION").value)).toMatchObject({ digest: id, workflow: WORKFLOW, inputs: { version: "3.1.0" } });
    expect(job.metadata.labels[NETWORK_LABEL]).toBe("isolated");
    expect(audit.filter((a) => a.action !== "signed-in").map((a) => a.action)).toEqual(["snapshot-stored", "execution-started"]);
    expect(audit.find((a) => a.action === "execution-started")).toMatchObject({ by: { id: oidcUserId(ISS, "alice"), name: "alice" }, initiatedBy: { name: "alice" } });
    expect(JSON.stringify(audit)).not.toMatch(/3\.1\.0/);
  });

  it("reports progress from the runner's events, archives the result, and limits concurrency", async () => {
    const { call, jobs, logs, boundDemo } = await setup({ maxConcurrent: 1 });
    const id = await boundDemo();
    const exec = (await call("POST", "executions", run(id))).body.execution;
    expect((await call("POST", "executions", run(id))).status).toBe(429);
    const signer = await ed25519EventSigner(exec.id);
    const ev = (e: object) => signer.sign({ at: NOW.toISOString(), ...e });
    logs.set(exec.id, [signer.keyLine, await ev({ type: "execution-start", executionId: exec.id, digest: id, workflow: WORKFLOW, source: { repository: DEMO_REPO, sha: "1".repeat(40) } }), await ev({ type: "job-start", job: "prepare", name: "prepare", workflow: WORKFLOW, needs: [] })].join("\n"));
    const running = (await call("GET", `executions/${exec.id}`)).body;
    expect(running.view.status).toBe("running");
    expect(running.view.jobs.map((j: { job: string }) => j.job)).toEqual(["prepare"]);
    logs.set(exec.id, `${logs.get(exec.id)}\n${await ev({ type: "job-end", job: "prepare", result: "success", outputs: {} })}\n${await ev({ type: "execution-end", result: "success", durationMs: 5, outputs: {} })}`);
    jobs.get(exec.jobName)!.status = { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] };
    expect((await call("GET", `executions/${exec.id}`)).body.view.status).toBe("success");
    jobs.clear();
    expect((await call("GET", `executions/${exec.id}`)).body).toMatchObject({ job: { state: "succeeded" }, view: { status: "success" } });
    expect((await call("POST", "executions", run(id))).status).toBe(201);
  });

  it("never leaves a finished Job looking pending: an unreadable runner log is reported", async () => {
    const { call, jobs, kube, boundDemo } = await setup();
    const id = await boundDemo();
    const exec = (await call("POST", "executions", run(id))).body.execution;
    kube.podLog = async () => {
      throw new Error("Kubernetes API GET /api/v1/namespaces/x/pods/y/log returned 406");
    };
    expect((await call("GET", `executions/${exec.id}`)).body.view).toMatchObject({ status: "pending", reason: expect.stringMatching(/Runner log unavailable: .*406/) });
    jobs.get(exec.jobName)!.status = { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] };
    expect((await call("GET", `executions/${exec.id}`)).body).toMatchObject({ job: { state: "succeeded" }, view: { status: "error", reason: expect.stringMatching(/406/) } });
  });

  it("explains a pod that can't start, from its warning events", async () => {
    const { call, warnings, setPhase, boundDemo } = await setup();
    const id = await boundDemo();
    const exec = (await call("POST", "executions", run(id))).body.execution;
    setPhase("Pending");
    warnings.push('FailedMount: MountVolume.SetUp failed for volume "secrets" : secret "demo-secrets" not found');
    expect((await call("GET", `executions/${exec.id}`)).body.job.reason).toMatch(/Pod not started: FailedMount: .*secret "demo-secrets" not found/);
  });

  it("refuses expired and non-executable snapshots, and removes expired ones", async () => {
    const { call, store } = await setup();
    const bad = await call("POST", "snapshots", await bundle({ ".github/workflows/release.yml": "on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ github.token }}\n" }));
    expect(bad.body.snapshot.executable).toBe(false);
    expect((await call("POST", "executions", { snapshotId: bad.body.snapshot.id, workflow: WORKFLOW })).body.details).toContain(
      "The executor's validation of the packaged files found errors or mismatches, so the snapshot is not executable",
    );
    const later = new Date(NOW.getTime() + 10 * 86_400_000);
    expect(store.list(later)).toEqual([]);
  });
});

// Security review C1: the demonstrated attacks, which must now fail.
// Security review H1: the demonstrated forgery and its variants, against the executor's API.
describe("security review H1: server-side validation, integrity and name ownership", () => {
  it("rejects the review's forged upload: errors stripped, production source claimed (422, nothing stored)", async () => {
    const { call, store } = await setup();
    const b = await bundle({ ".github/workflows/release.yml": "on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n        n: [1]\n    steps:\n      - run: echo ${{ github.token }}\n" });
    const forged = { ...b, manifest: { ...b.manifest, diagnostics: [], source: { repository: "acme/production-deploy", ref: "main", sha: "f".repeat(40) } } };
    const r = await call("POST", "snapshots", forged);
    expect(r.status).toBe(422);
    expect(r.body.details.map((d: { code: string }) => d.code)).toEqual(expect.arrayContaining(["manifest-mismatch"]));
    expect(store.list(NOW)).toEqual([]);
    const stripped = { ...b, manifest: { ...b.manifest, diagnostics: [] } };
    expect((await call("POST", "snapshots", stripped)).body.details.map((d: { message: string }) => d.message).join()).toMatch(/under-reports validation errors/);
  });

  it("rejects uploads whose claims differ from the files: an added secret requirement, an altered file with a forged Git blob ID", async () => {
    const { call } = await setup();
    const b = await bundle();
    const extra = JSON.parse(JSON.stringify(b)) as SnapshotBundle;
    extra.manifest.requirements.secrets.push({ name: "PROD_DB_PASSWORD", usedBy: ["x"] });
    expect((await call("POST", "snapshots", extra)).body.details.map((d: { message: string }) => d.message).join()).toMatch(/requirements do not match/);
    const wrongBlob = JSON.parse(JSON.stringify(b)) as SnapshotBundle;
    wrongBlob.manifest.files[0]!.gitBlob = "0".repeat(40);
    expect((await call("POST", "snapshots", wrongBlob)).body.details.map((d: { code: string }) => d.code)).toContain("git-blob-mismatch");
  });

  it("stores the executor's own verdict and integrity, not the uploader's", async () => {
    const { call } = await setup();
    const r = await call("POST", "snapshots", await bundle());
    expect(r.body.snapshot).toMatchObject({ executable: true, validation: { by: "executor", executable: true } });
    expect(r.body.snapshot.integrity.map((i: { status: string }) => i.status)).toEqual(["tree-verified", "tree-verified"]);
    const self = await bundle();
    self.manifest.diagnostics.unshift({ severity: "error", code: "self-declared", message: "do not run" });
    const declared = await call("POST", "snapshots", self);
    expect(declared.body.snapshot).toMatchObject({ executable: false });
    expect((await call("POST", "executions", run(declared.body.snapshot.id))).status).toBe(422);
  });

  it("a name belongs to its repository: another repository can't add a version under it", async () => {
    const { call } = await setup();
    expect((await call("POST", "snapshots", await bundle())).status).toBe(201);
    const squat = await call("POST", "snapshots", await bundle({}, 7, "acme/production-deploy"));
    expect(squat.status).toBe(422);
    expect(squat.body.details[0]).toMatchObject({ code: "name-owned", message: expect.stringMatching(/belongs to snapshots of emergency-demo\/release-pipeline/) });
    const sameRepo = await call("POST", "snapshots", await bundle({ "src/app/main.txt": "v2\n" }));
    expect(sameRepo.body.snapshot).toMatchObject({ version: 2 });
  });

  it("a new version never inherits authorization: the binding names the old digest, so the new one gets no Secret", async () => {
    const { call, boundDemo, jobs } = await setup();
    const v1 = await boundDemo();
    const v2 = (await call("POST", "snapshots", await bundle({ "scripts/build.sh": "echo changed\n" }))).body.snapshot;
    expect(v2).toMatchObject({ name: "release demo", version: 2 });
    expect((await call("POST", "executions", run(v2.id))).body.details.join()).toMatch(/No Secret is bound to this snapshot/);
    expect((await call("POST", "executions", run(v1))).status).toBe(201);
    expect(jobs.size).toBe(1);
  });

  it("snapshots stored before H1 are validated by the executor on first use, and keep working", async () => {
    const { call, store, bindings } = await setup();
    const id = (await call("POST", "snapshots", await bundle())).body.snapshot.id as string;
    // Turn it into a pre-H1 record: no stored validation.
    const recordPath = join(store.dataDir, store.subPath(id), "record.json");
    chmodSync(join(store.dataDir, store.subPath(id)), 0o755);
    chmodSync(recordPath, 0o644);
    const legacy = JSON.parse(readFileSync(recordPath, "utf8"));
    delete legacy.validation;
    delete legacy.integrity;
    writeFileSync(recordPath, JSON.stringify(legacy));
    const got = (await call("GET", `snapshots/${id}`)).body;
    expect(got.record).toMatchObject({ executable: true, validation: { by: "executor", executable: true } });
    expect(existsSync(join(store.dataDir, "validations", `${id}.json`))).toBe(true);
    bindings.push({ name: "release-demo", secret: "demo-secrets", keys: ["DEMO_SIGNING_KEY"], snapshots: [id] });
    expect((await call("POST", "executions", run(id))).status).toBe(201);
  });
});

describe("security review C1: Secret isolation", () => {
  it("the operator can no longer choose a Secret: naming one is refused, whatever it is", async () => {
    const { call, jobs, boundDemo } = await setup();
    const id = await boundDemo();
    for (const secretName of [OPERATOR_SECRET, "prod-secrets", "demo-secrets"]) {
      const r = await call("POST", "executions", run(id, { secretName }));
      expect(r.status).toBe(422);
      expect(r.body.details.join("\n")).toMatch(/secretName can't be chosen/);
    }
    expect(jobs.size).toBe(0);
  });

  it("a snapshot with no binding for its digest gets no Secret and does not run", async () => {
    const { call, jobs } = await setup();
    const id = (await call("POST", "snapshots", await bundle())).body.snapshot.id;
    const r = await call("POST", "executions", run(id));
    expect(r.status).toBe(422);
    expect(r.body.details.join("\n")).toMatch(new RegExp(`No Secret is bound to this snapshot.*${id}`));
    expect(jobs.size).toBe(0);
  });

  it("a binding for one snapshot does not serve another, even with the same name and claimed repository", async () => {
    const { call, jobs, boundDemo } = await setup();
    await boundDemo();
    const other = (await call("POST", "snapshots", await bundle({ "scripts/build.sh": "echo look-alike\n" }))).body.snapshot;
    expect(other).toMatchObject({ name: "release demo", source: { repository: DEMO_REPO } });
    expect((await call("POST", "executions", run(other.id))).status).toBe(422);
    expect(jobs.size).toBe(0);
  });

  it("only the keys the snapshot requires are mounted, never the rest of the bound Secret", async () => {
    const { call, jobs, bindings, boundDemo } = await setup();
    const id = await boundDemo();
    bindings[0]!.keys = ["DEMO_SIGNING_KEY", "OTHER_TEAM_TOKEN", "PROD_DB_PASSWORD"];
    expect((await call("POST", "executions", run(id))).status).toBe(201);
    const pod = ([...jobs.values()][0]!.spec as any).spec.template.spec;
    expect(pod.volumes.find((v: any) => v.name === "secrets").secret.items).toEqual([{ key: "DEMO_SIGNING_KEY", path: "DEMO_SIGNING_KEY" }]);
  });

  it("a binding that doesn't permit a required key is refused", async () => {
    const { call, bindings, boundDemo } = await setup();
    const id = await boundDemo();
    bindings[0]!.keys = ["SOMETHING_ELSE"];
    expect((await call("POST", "executions", run(id))).body.details.join("\n")).toMatch(/does not permit DEMO_SIGNING_KEY/);
  });

  it("the operator-token Secret can't be bound, invalid bindings bind nothing, and ambiguous bindings are refused", async () => {
    const digest = "a".repeat(64);
    expect(parseBindings(JSON.stringify([{ name: "x", secret: OPERATOR_SECRET, keys: ["K"], snapshots: [digest] }]), OPERATOR_SECRET).problems.join()).toMatch(/operator-token Secret can never be bound/);
    for (const bad of [{ name: "x", secret: "s", keys: [], snapshots: [digest] }, { name: "x", secret: "s", keys: ["K"], snapshots: ["release demo"] }, { name: "x", secret: "Bad_Name", keys: ["K"], snapshots: [digest] }]) {
      expect(parseBindings(JSON.stringify([bad]), OPERATOR_SECRET).bindings).toEqual([]);
    }
    const { call, boundDemo, bindings } = await setup();
    const id = await boundDemo();
    bindings.push({ name: "second", secret: "other", keys: ["DEMO_SIGNING_KEY"], snapshots: [id] });
    expect((await call("POST", "executions", run(id))).body.details.join("\n")).toMatch(/More than one Secret binding/);
  });

  it("a bindings file naming the operator Secret makes every binding void (fail closed)", async () => {
    const b = await bundle();
    const { call } = await setup({ bindingsJson: JSON.stringify([{ name: "x", secret: OPERATOR_SECRET, keys: ["DEMO_SIGNING_KEY"], snapshots: ["a".repeat(64)] }]) });
    const id = (await call("POST", "snapshots", b)).body.snapshot.id;
    expect((await call("POST", "executions", run(id))).body.details.join("\n")).toMatch(/Secret bindings are invalid, so none apply/);
  });
});

// Security review C2.
describe("security review C2: network isolation gate", () => {
  for (const state of ["not-enforced", "unverified", "never"] as const) {
    it(`refuses isolated executions when the network check is ${state}`, async () => {
      const { call, jobs, boundDemo } = await setup({ network: state });
      const id = await boundDemo();
      const r = await call("POST", "executions", run(id));
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/Isolated execution refused/);
      expect(jobs.size).toBe(0);
    });
  }

  it("re-checks before every execution (a stale proof is never reused past its age)", async () => {
    const { call, net, boundDemo } = await setup();
    const id = await boundDemo();
    await call("POST", "executions", run(id));
    await call("POST", "executions", run(id));
    expect(net.calls.ensureFresh).toBe(2);
  });

  it('"github-blocked" no longer exists, and egress mode is refused unless enabled and proven', async () => {
    const { call, boundDemo } = await setup();
    const id = await boundDemo();
    expect((await call("POST", "executions", run(id, { network: "github-blocked" }))).body.details.join()).toMatch(/was removed: it blocked only GitHub's hostnames and was not isolated/);
    expect((await call("POST", "executions", run(id, { network: "egress" }))).body.details.join()).toMatch(/Egress mode is disabled/);

    const enabled = await setup({ allowEgress: true, egress: { state: "not-enforced", reason: "reached kubernetes-api", results: [] } });
    const id2 = await enabled.boundDemo();
    const refused = await enabled.call("POST", "executions", run(id2, { network: "egress" }));
    expect(refused.status).toBe(409);
    expect(refused.body.details).toEqual(["reached kubernetes-api"]);

    const proven = await setup({ allowEgress: true, egress: { state: "enforced", results: [] } });
    const id3 = await proven.boundDemo();
    const ok = await proven.call("POST", "executions", run(id3, { network: "egress" }));
    expect(ok.status).toBe(201);
    const pod = ([...proven.jobs.values()][0]!.spec as any).spec.template;
    expect(pod.metadata.labels[NETWORK_LABEL]).toBe("egress");
    expect(pod.spec.dnsPolicy).toBeUndefined();
  });
});

// Security review H4. The policy itself is enforced by the API server; tools/emergency/admission-check.ts tests it
// against a real one. Here: the executor refuses to run until the API server has proven it enforces the policy.
describe("security review H4: admission enforcement gate", () => {
  for (const state of ["not-enforced", "unverified", "never"] as const) {
    it(`refuses executions when the admission check is ${state}, before any canary or Job`, async () => {
      const { call, jobs, boundDemo, net } = await setup({ admission: state });
      const id = await boundDemo();
      const r = await call("POST", "executions", run(id));
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/does not enforce the runner admission policy/);
      expect(r.body.details).toEqual([`stub admission: ${state}`]);
      expect(jobs.size).toBe(0);
      expect(net.calls.ensureFresh).toBe(0);
    });
  }

  it("re-checks before every execution, and reports its state to operators only", async () => {
    const { call, adm, boundDemo } = await setup();
    const id = await boundDemo();
    await call("POST", "executions", run(id));
    await call("POST", "executions", run(id));
    expect(adm.calls.ensureFresh).toBe(2);
    expect((await call("GET", "admission-check", undefined, null)).status).toBe(401);
    expect((await call("GET", "admission-check")).body).toMatchObject({ state: "enforced" });
  });
});

const POLICY = "gha-emergency-runner-jobs.gha-emergency";
const admissionConfig = { namespace: "gha-emergency", runnerImage: `runner@sha256:${"a".repeat(64)}`, runnerServiceAccount: "gha-emergency-runner", executorPodLabels: { app: "executor" }, isolation: { mode: "colocated" as const }, policyName: POLICY, maxAgeMs: 900_000, retryMs: 30_000 };
const hasHostPath = (job: object) => ((job as any).spec.template.spec.volumes as any[]).some((v) => v.hostPath);

/** An API server that answers dry runs as scripted; every real create is recorded (there must be none). */
function admissionKube(answer: (job: object) => Error | undefined) {
  const created: object[] = [];
  const dryRuns: object[] = [];
  const kube: KubeApi = {
    async createJob(job, options) {
      if (!options?.dryRun) {
        created.push(job);
        return;
      }
      dryRuns.push(job);
      const error = answer(job);
      if (error) throw error;
    },
    getJob: async () => undefined,
    deleteJob: async () => {},
    listPods: async () => [],
    podLog: async () => "",
    podWarnings: async () => [],
  };
  return { kube, created, dryRuns };
}
const policyDenial = () => new KubeError(403, `Kubernetes API POST /apis/batch/v1/namespaces/gha-emergency/jobs returned 403: jobs.batch "x" is forbidden: ValidatingAdmissionPolicy '${POLICY}' with binding '${POLICY}' denied request: volumes are limited to ...`);

describe("security review H4: the executor's admission check", () => {
  it("the two probes differ only by the hostPath volume, and are otherwise a legitimate canary", () => {
    const { accepted, denied } = admissionProbes(admissionConfig, "abcd1234");
    const strip = (j: any) => ({ ...j, metadata: { ...j.metadata, name: "" }, spec: { ...j.spec, template: { ...j.spec.template, spec: { ...j.spec.template.spec, volumes: j.spec.template.spec.volumes.filter((v: any) => !v.hostPath) } } } });
    expect(strip(denied)).toEqual(strip(accepted));
    expect(hasHostPath(denied)).toBe(true);
    expect(hasHostPath(accepted)).toBe(false);
    expect(accepted.spec.template.metadata.labels).toMatchObject(RUNNER_POD_LABELS);
  });

  it('"enforced" only when the policy refuses the hostPath probe and the API server accepts the legitimate one, all as dry runs', async () => {
    const k = admissionKube((job) => (hasHostPath(job) ? policyDenial() : undefined));
    const r = await createAdmissionCheck({ kube: k.kube, config: admissionConfig, now: () => NOW }).run();
    expect(r).toMatchObject({ state: "enforced", checkedAt: NOW.toISOString() });
    expect(k.dryRuns).toHaveLength(2);
    expect(k.created).toHaveLength(0);
  });

  it('"not-enforced" when the API server accepts the hostPath probe (policy missing, unbound, or another namespace)', async () => {
    const k = admissionKube(() => undefined);
    const r = await createAdmissionCheck({ kube: k.kube, config: admissionConfig }).run();
    expect(r.state).toBe("not-enforced");
    expect(r.reason).toMatch(/accepted a runner Job with a hostPath volume/);
  });

  it('"unverified" when something other than the policy refuses the probe, or the legitimate Job is refused too', async () => {
    const other = admissionKube((job) => (hasHostPath(job) ? new KubeError(403, 'jobs.batch is forbidden: User "x" cannot create resource "jobs"') : undefined));
    expect((await createAdmissionCheck({ kube: other.kube, config: admissionConfig }).run()).state).toBe("unverified");
    const otherPolicy = admissionKube((job) => (hasHostPath(job) ? new KubeError(403, "ValidatingAdmissionPolicy 'someone-else' with binding 'b' denied request") : undefined));
    expect((await createAdmissionCheck({ kube: otherPolicy.kube, config: admissionConfig }).run()).state).toBe("unverified");
    // The policy refuses everything when the namespace isn't dedicated and restricted.
    const all = admissionKube(() => policyDenial());
    const r = await createAdmissionCheck({ kube: all.kube, config: admissionConfig }).run();
    expect(r.state).toBe("unverified");
    expect(r.reason).toMatch(/refused a legitimate runner Job/);
    const down = admissionKube(() => new Error("connect ECONNREFUSED"));
    expect((await createAdmissionCheck({ kube: down.kube, config: admissionConfig }).run()).state).toBe("unverified");
  });

  it("reuses an enforced result for maxAgeMs and any other result only for retryMs", async () => {
    let t = NOW.getTime();
    let enforce = false;
    const k = admissionKube((job) => (enforce && hasHostPath(job) ? policyDenial() : undefined));
    const check = createAdmissionCheck({ kube: k.kube, config: { ...admissionConfig, maxAgeMs: 60_000, retryMs: 5_000 }, now: () => new Date(t) });
    expect((await check.ensureFresh()).state).toBe("not-enforced");
    enforce = true;
    t += 4_000;
    expect((await check.ensureFresh()).state).toBe("not-enforced");
    t += 2_000;
    expect((await check.ensureFresh()).state).toBe("enforced");
    enforce = false;
    t += 59_000;
    expect((await check.ensureFresh()).state).toBe("enforced");
    t += 2_000;
    expect((await check.ensureFresh()).state).toBe("not-enforced");
  });
});

/** A cluster for the canary: the probe and control pods "connect" according to the scenario. */
function canaryCluster(scenario: (role: string, target: CanaryTarget) => boolean, opts: { probeNeverFinishes?: boolean; garbleControl?: boolean } = {}) {
  let current = scenario;
  const jobs = new Map<string, { spec: any; done: boolean }>();
  const created: any[] = [];
  const deleted: string[] = [];
  const kube: KubeApi = {
    async createJob(job: any) {
      created.push(job);
      jobs.set(job.metadata.name, { spec: job, done: !(opts.probeNeverFinishes && job.metadata.name.endsWith("probe-isolated")) });
    },
    async getJob(name) {
      const j = jobs.get(name);
      return j ? { metadata: { name }, status: j.done ? { succeeded: 1 } : { active: 1 } } : undefined;
    },
    async deleteJob(name) {
      deleted.push(name);
    },
    async listPods() {
      return [...jobs.keys()].map((name) => ({ metadata: { name: `${name}-x1` }, status: { phase: "Succeeded" } }));
    },
    async podLog(pod) {
      const job = jobs.get(pod.replace(/-x1$/, ""))!.spec;
      const role = job.metadata.name.replace(/^gha-emergency-canary-[0-9a-f]+-/, "");
      if (opts.garbleControl && role === "control") return "not canary output";
      const targets = JSON.parse(job.spec.template.spec.containers[0].env[0].value) as CanaryTarget[];
      return targets.map((t) => `${CANARY_PREFIX}${JSON.stringify({ ...t, reachable: current(role, t), detail: "test" })}`).join("\n");
    },
    async podWarnings() {
      return [];
    },
  };
  let t = NOW.getTime();
  const checker = createNetworkCheck({
    kube,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
    config: {
      namespace: "ns",
      runnerImage: "runner:test",
      runnerServiceAccount: "runner",
      executorPodLabels: { app: "executor" },
      isolation: { mode: "colocated" as const },
      externalTarget: { host: "1.1.1.1", port: 443 },
      apiServer: { host: "10.96.0.1", port: 443 },
      metadataTarget: { host: "169.254.169.254", port: 80 },
      internalService: async () => ({ host: "10.96.12.34", port: 8080 }),
      egressEnabled: true,
      maxAgeMs: 15 * 60_000,
      retryMs: 30_000,
      timeoutMs: 90_000,
      pollMs: 2_000,
    },
  });
  return { checker, created, deleted, advance: (ms: number) => (t += ms), setScenario: (s: typeof scenario) => (current = s) };
}

describe("security review C2: the network canary", () => {
  it("proves enforcement only when the probe reaches nothing and the control reaches the internal service", async () => {
    const c = canaryCluster((role) => role === "control");
    const r = await c.checker.run();
    expect(r.state).toBe("enforced");
    expect(r.isolated.map((x) => x.name).sort()).toEqual(["cloud-metadata", "external-ip", "internal-service", "kubernetes-api"]);
    expect(r.egress?.state).toBe("enforced");
    expect(c.deleted.length).toBe(3);
  });

  it("the original C2 attack (direct IP, internal service, API server) is detected as not enforced", async () => {
    // kindnet on minikube: every pod reaches everything.
    const c = canaryCluster(() => true);
    const r = await c.checker.run();
    expect(r.state).toBe("not-enforced");
    expect(r.reason).toMatch(/external-ip \(1\.1\.1\.1:443\).*kubernetes-api \(10\.96\.0\.1:443\).*cloud-metadata.*internal-service \(10\.96\.12\.34:8080\)/);
    expect(r.egress?.state).toBe("not-enforced");
  });

  it("one leak is enough: a probe that reaches only the metadata address is not enforced", async () => {
    const c = canaryCluster((role, t) => role === "control" || t.name === "cloud-metadata");
    expect((await c.checker.run()).state).toBe("not-enforced");
  });

  it("a broken network proves nothing: if the control can't reach the internal service, the result is unverified", async () => {
    const c = canaryCluster(() => false);
    const r = await c.checker.run();
    expect(r.state).toBe("unverified");
    expect(r.reason).toMatch(/control pod could not reach the internal service/);
  });

  it("canaries that don't finish or report garbage are unverified, never enforced", async () => {
    expect((await canaryCluster((role) => role === "control", { probeNeverFinishes: true }).checker.run()).reason).toMatch(/probe-isolated canary did not finish/);
    expect((await canaryCluster((role) => role === "control", { garbleControl: true }).checker.run()).state).toBe("unverified");
  });

  it("probes carry exactly an execution's labels, network settings and pod security; the control does not", async () => {
    const c = canaryCluster((role) => role === "control");
    await c.checker.run();
    const byRole = (r: string) => c.created.find((j) => j.metadata.name.endsWith(r));
    const probe = byRole("probe-isolated").spec.template;
    const exec = buildJob({ ...jobInput, network: "isolated" }).spec.template;
    expect(probe.metadata.labels).toMatchObject({ ...RUNNER_POD_LABELS, [NETWORK_LABEL]: "isolated" });
    for (const k of ["hostAliases", "dnsPolicy", "dnsConfig", "securityContext", "automountServiceAccountToken", "enableServiceLinks"] as const) expect(probe.spec[k]).toEqual((exec.spec as any)[k]);
    expect(probe.spec.containers[0].securityContext).toEqual(exec.spec.containers[0]!.securityContext);
    const control = byRole("control").spec.template;
    expect(control.metadata.labels["app.kubernetes.io/name"]).toBe("gha-emergency-canary-control");
    expect(control.spec.dnsPolicy).toBeUndefined();
    expect(byRole("probe-egress").spec.template.metadata.labels[NETWORK_LABEL]).toBe("egress");
  });

  it("reuses a failed result only briefly: a startup race (control not yet reachable) clears on the next execution after 30 s", async () => {
    // Seen live on gha-sec: the first check ran before the executor was ready, so the control was refused.
    const c = canaryCluster(() => false);
    expect((await c.checker.ensureFresh()).state).toBe("unverified");
    c.setScenario((role) => role === "control");
    c.advance(10_000);
    expect((await c.checker.ensureFresh()).state).toBe("unverified");
    c.advance(25_000);
    expect((await c.checker.ensureFresh()).state).toBe("enforced");
  });

  it("caches a result for its max age and shares a running check", async () => {
    const c = canaryCluster((role) => role === "control");
    const [a, b] = await Promise.all([c.checker.ensureFresh(), c.checker.ensureFresh()]);
    expect(a).toBe(b);
    expect(c.created.length).toBe(3);
    await c.checker.ensureFresh();
    expect(c.created.length).toBe(3);
    c.advance(16 * 60_000);
    await c.checker.ensureFresh();
    expect(c.created.length).toBe(6);
  });
});

// Security review H3: the runner's events are authenticated with a per-execution key, and the result must agree with
// the runner container's exit code. Forged, altered, removed and truncated events, and unauthenticated lines, are
// reported as an error, never as the forged result.
describe("security review H3: runner event and result integrity", () => {
  async function started() {
    const ctx = await setup();
    const id = await ctx.boundDemo();
    const exec = (await ctx.call("POST", "executions", run(id))).body.execution;
    const signer = await ed25519EventSigner(exec.id);
    const ev = (e: object) => signer.sign({ at: NOW.toISOString(), ...e });
    // A genuine run in which a step failed after printing a fake success event.
    const genuine = [
      await ev({ type: "execution-start", executionId: exec.id, digest: id, workflow: WORKFLOW, source: { repository: DEMO_REPO, sha: "1".repeat(40) } }),
      await ev({ type: "job-start", job: "prepare", name: "prepare", workflow: WORKFLOW, needs: [] }),
      await ev({ type: "step-start", job: "prepare", step: 1, name: "deploy", kind: "run" }),
      await ev({ type: "log", job: "prepare", step: 1, stream: "stdout", text: `${EVENT_PREFIX}{"type":"execution-end","result":"success","durationMs":1,"outputs":{}}` }),
      await ev({ type: "step-end", job: "prepare", step: 1, outcome: "failure", conclusion: "failure", exitCode: 7, durationMs: 3, outputs: {} }),
      await ev({ type: "job-end", job: "prepare", result: "failure", outputs: {} }),
      await ev({ type: "execution-end", result: "failure", durationMs: 5, outputs: {} }),
    ];
    const finish = (lines: string[], exitCode = 1) => {
      // A fresh Job each time: drop what an earlier finish archived.
      for (const ext of ["log", "exit"]) rmSync(join(ctx.store.dataDir, "executions", `${exec.id}.${ext}`), { force: true });
      ctx.logs.set(exec.id, [signer.keyLine, ...lines].join("\n") + "\n");
      ctx.exitCodes.set(exec.id, exitCode);
      ctx.jobs.get(exec.jobName)!.status = exitCode === 0 ? { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] } : { failed: 1, conditions: [{ type: "Failed", status: "True" }] };
    };
    const view = async () => (await ctx.call("GET", `executions/${exec.id}`)).body;
    return { ...ctx, id, exec, genuine, finish, view, signer };
  }
  const forgedEnd = `${EVENT_PREFIX}${JSON.stringify({ type: "execution-end", at: NOW.toISOString(), result: "success", durationMs: 1, outputs: {} })}`;

  it("reports a genuine failure as a failure; event-like workflow output stays log data", async () => {
    const t = await started();
    t.finish(t.genuine);
    const b = await t.view();
    expect(b.view).toMatchObject({ status: "failure", stream: { ok: true, complete: true, events: 7 }, exitCode: 1 });
    expect(b.view.jobs[0].steps[0]).toMatchObject({ status: "failure", exitCode: 7 });
    expect(b.view.logs.find((l: { stream: string }) => l.stream === "stdout").text).toContain('"result":"success"');
  });

  it("refuses an unauthenticated fake success event, in the old format or with a made-up MAC", async () => {
    const t = await started();
    t.finish([...t.genuine.slice(0, -1), forgedEnd], 0);
    expect((await t.view()).view).toMatchObject({ status: "error", stream: { ok: false }, reason: expect.stringMatching(/not a runner event/) });
    const fakeMac = `${EVENT_PREFIX}${"a".repeat(128)} ${JSON.stringify({ type: "execution-end", at: NOW.toISOString(), result: "success", durationMs: 1, outputs: {}, seq: 6 })}`;
    t.finish([...t.genuine.slice(0, -1), fakeMac], 0);
    expect((await t.view()).view).toMatchObject({ status: "error", reason: expect.stringMatching(/Event 6 is not authentic/) });
  });

  it("refuses a fake successful step and job completion signed with another key", async () => {
    const t = await started();
    const otherSigner = await ed25519EventSigner(t.exec.id);
    const other = otherSigner.sign;
    for (let i = 0; i < 4; i++) await other({});
    const lines = [
      ...t.genuine.slice(0, 4),
      await other({ type: "step-end", at: NOW.toISOString(), job: "prepare", step: 1, outcome: "success", conclusion: "success", exitCode: 0, durationMs: 1, outputs: {} }),
      await other({ type: "job-end", at: NOW.toISOString(), job: "prepare", result: "success", outputs: {} }),
    ];
    t.finish(lines, 0);
    const v = (await t.view()).view;
    expect(v).toMatchObject({ status: "error", stream: { ok: false, events: 4 } });
    expect(v.jobs[0].status).toBe("running");
  });

  it("refuses removed, modified, reordered or truncated events", async () => {
    const t = await started();
    t.finish(t.genuine.filter((_, i) => i !== 4));
    expect((await t.view()).view).toMatchObject({ status: "error", reason: expect.stringMatching(/not authentic/) });
    const modified = t.genuine.map((l, i) => (i === 4 ? l.replace('"outcome":"failure","conclusion":"failure","exitCode":7', '"outcome":"success","conclusion":"success","exitCode":0') : l));
    expect(modified[4]).not.toBe(t.genuine[4]);
    t.finish(modified);
    expect((await t.view()).view).toMatchObject({ status: "error", reason: expect.stringMatching(/Event 4 is not authentic/) });
    t.finish([t.genuine[0]!, t.genuine[2]!, t.genuine[1]!, ...t.genuine.slice(3)]);
    expect((await t.view()).view.status).toBe("error");
    t.finish(t.genuine.slice(0, 4));
    expect((await t.view()).view).toMatchObject({ status: "error", reason: expect.stringMatching(/incomplete/) });
    // Lost from the start, as by log rotation: the first line is a later event.
    t.finish(t.genuine.slice(2));
    expect((await t.view()).view.status).toBe("error");
  });

  it("cross-checks the runner's result against its container's exit code", async () => {
    const t = await started();
    t.finish(t.genuine, 0);
    expect((await t.view()).view).toMatchObject({ status: "error", reason: "The runner reported failure, but its container exited with code 0" });
  });

  it("archives the exit code with the log, so the checks still apply after the Job is gone", async () => {
    const t = await started();
    t.finish(t.genuine, 0);
    await t.view();
    t.jobs.clear();
    expect(await t.view()).toMatchObject({ job: { state: "succeeded" }, view: { status: "error", exitCode: 0, stream: { ok: true } } });
    t.store.archiveLog(t.exec.id, [t.signer.keyLine, ...t.genuine.slice(0, -1), forgedEnd].join("\n"), 0);
    expect((await t.view()).view.status).toBe("error");
  });

  it("has no key to steal: nothing in the Job, the executor's records or the API can sign events (review H2)", async () => {
    const t = await started();
    const env = (t.jobs.get(t.exec.jobName)!.spec as any).spec.template.spec.containers[0].env as { name: string }[];
    expect(env.map((e) => e.name)).not.toContain("GHA_EMERGENCY_EVENT_KEY");
    expect(t.store.eventKey(t.exec.id)).toBeUndefined();
    expect(readdirSync(join(t.store.dataDir, "executions")).filter((f) => f.endsWith(".key"))).toEqual([]);
    expect(t.store.getExecution(t.exec.id)!.eventAuth).toBe("ed25519");
    // A log that does not begin with this execution's own key line is not believed.
    t.finish(t.genuine);
    t.logs.set(t.exec.id, t.genuine.join("\n"));
    expect((await t.view()).view).toMatchObject({ status: "error", reason: expect.stringMatching(/does not begin with its public key/) });
  });

  it("still verifies executions recorded under H3 with the key the executor kept, and reads older ones as unverifiable", async () => {
    const t = await started();
    // As recorded between H3 and H2: an executor-generated key in <id>.key, HMAC-chained events, no eventAuth.
    const key = "0123456789abcdef".repeat(4);
    writeFileSync(join(t.store.dataDir, "executions", `${t.exec.id}.key`), key);
    t.store.saveExecution({ ...t.store.getExecution(t.exec.id)!, eventAuth: undefined });
    const sign = await eventSigner(key);
    const h3: string[] = [];
    for (const e of [{ type: "execution-start", executionId: t.exec.id, digest: t.id, workflow: WORKFLOW, source: { repository: DEMO_REPO, sha: "1".repeat(40) } }, { type: "execution-end", result: "success", durationMs: 5, outputs: {} }]) h3.push(await sign({ at: NOW.toISOString(), ...e }));
    t.store.archiveLog(t.exec.id, h3.join("\n"), 0);
    expect((await t.view()).view).toMatchObject({ status: "success", stream: { ok: true } });
    expect(JSON.stringify(await t.view())).not.toContain(key);
    rmSync(join(t.store.dataDir, "executions", `${t.exec.id}.key`));
    const legacy = [
      { type: "execution-start", executionId: t.exec.id, digest: t.id, workflow: WORKFLOW, source: { repository: DEMO_REPO, sha: "1".repeat(40) } },
      { type: "execution-end", result: "success", durationMs: 5, outputs: {} },
    ].map((e) => `${EVENT_PREFIX}${JSON.stringify({ at: NOW.toISOString(), ...e })}`);
    t.store.archiveLog(t.exec.id, legacy.join("\n"), 0);
    expect((await t.view()).view).toMatchObject({ status: "success", stream: { ok: false, legacy: true, problem: expect.stringMatching(/not verifiable/) } });
  });
});

const jobInput = {
  executionId: "0123456789abcdef",
  snapshotId: "a".repeat(64),
  snapshotName: "demo",
  snapshotVersion: 3,
  workflow: WORKFLOW,
  inputs: {},
  variables: {},
  secret: { name: "demo-secrets", keys: ["DEMO_SIGNING_KEY"] },
  network: "isolated" as const,
  namespace: "ns",
  runnerImage: "img",
  pvcName: "pvc",
  snapshotSubPath: `snapshots/${"a".repeat(64)}`,
  serviceAccountName: "runner",
  executorPodLabels: { app: "executor" },
  isolation: { mode: "colocated" as const },
  resources: { cpu: "500m", memory: "512Mi", scratch: "1Gi" },
  maxMinutes: 20,
  ttlSecondsAfterFinished: 600,
};

describe("runner Job specification", () => {
  const job = buildJob(jobInput);
  const pod = job.spec.template.spec;
  const c = pod.containers[0]!;

  it("starts the runner from the execute-only node without the SIGUSR1 inspector (review H3), and gives it no key (H2)", () => {
    expect(c.command.slice(0, 2)).toEqual([RUNNER_NODE, "--disable-sigusr1"]);
    expect(c.env.map((e) => e.name)).not.toContain("GHA_EMERGENCY_EVENT_KEY");
  });

  it("has no Kubernetes API access and no retries, and is time- and resource-limited", () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.serviceAccountName).toBe("runner");
    expect(pod.enableServiceLinks).toBe(false);
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.activeDeadlineSeconds).toBe(20 * 60 + 120);
    expect(c.resources.limits).toEqual({ cpu: "500m", memory: "512Mi", "ephemeral-storage": "1Gi" });
  });

  it("runs as non-root with a read-only root filesystem and no capabilities", () => {
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: "RuntimeDefault" } });
    expect(c.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } });
  });

  it("is selected by the deny-all NetworkPolicy, and keeps name-based GitHub blocking as defence in depth", () => {
    expect(job.spec.template.metadata.labels).toMatchObject({ ...RUNNER_POD_LABELS, [NETWORK_LABEL]: "isolated" });
    expect(pod.hostAliases).toEqual([{ ip: "127.0.0.1", hostnames: GITHUB_HOSTS }]);
    expect(pod.dnsPolicy).toBe("None");
  });

  it("carries no secret values and projects only the listed keys", () => {
    expect(JSON.stringify(c.env)).not.toMatch(/secretKeyRef|DEMO_SIGNING_KEY/);
    expect(c.volumeMounts).toContainEqual({ name: "secrets", mountPath: "/secrets", readOnly: true });
    expect((pod.volumes as any[]).find((v) => v.name === "secrets").secret.items).toEqual([{ key: "DEMO_SIGNING_KEY", path: "DEMO_SIGNING_KEY" }]);
  });

  it("canary Jobs are short-lived and as locked down as executions", () => {
    const canary = buildCanaryJob({ checkId: "abcd1234", role: "probe-isolated", targets: [], namespace: "ns", runnerImage: "img", serviceAccountName: "runner", executorPodLabels: { app: "executor" }, isolation: { mode: "colocated" as const } });
    expect(canary.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 120, ttlSecondsAfterFinished: 300 });
    expect(canary.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(canary.spec.template.spec.containers[0]!.securityContext.readOnlyRootFilesystem).toBe(true);
  });
});

// ---- security review H2: authentication, authorization, approval, attribution --------------------------------------

const uid = (sub: string) => oidcUserId(ISS, sub);
const denials = (audit: Record<string, unknown>[]) => audit.filter((a) => a.action === "authorization-denied");

describe("security review H2: authentication", () => {
  it("refuses every sensitive operation without a session, and audits the refusal", async () => {
    const { call, audit } = await setup();
    expect((await call("GET", "health", undefined, null)).body).toMatchObject({ available: true, signIn: { oidc: { label: expect.any(String) }, breakGlass: true } });
    const routes: [string, string][] = [
      ["GET", "snapshots"], ["POST", "snapshots"], ["GET", `snapshots/${"a".repeat(64)}`], ["POST", `snapshots/${"a".repeat(64)}/verify`], ["DELETE", `snapshots/${"a".repeat(64)}`],
      ["GET", "executions"], ["POST", "executions"], ["GET", "executions/0123456789abcdef"], ["DELETE", "executions/0123456789abcdef"], ["POST", "executions/0123456789abcdef/approve"], ["POST", "executions/0123456789abcdef/start"],
      ["GET", "network-check"], ["POST", "network-check"], ["GET", "admission-check"], ["POST", "admission-check"],
      ["GET", "admin/users"], ["PUT", `admin/users/${uid("alice")}/roles`], ["POST", `admin/users/${uid("alice")}/disable`], ["POST", `admin/users/${uid("alice")}/revoke-sessions`],
      ["GET", "admin/bindings"], ["PUT", "admin/bindings/release-demo"], ["GET", "admin/audit"], ["GET", "auth/session"], ["POST", "auth/logout"],
    ];
    for (const [method, path] of routes) expect([method, path, (await call(method, path, {}, null)).status]).toEqual([method, path, 401]);
    expect(denials(audit)).toHaveLength(routes.length);
    expect(denials(audit)[0]).toMatchObject({ by: null, reason: expect.stringMatching(/No valid session/) });
  });

  it("refuses the old shared operator token, and API calls without the page's CSRF header", async () => {
    const { call } = await setup();
    const bearer = await call("GET", "snapshots", undefined, "alice", { authorization: "Bearer operator-token-for-tests-0123456789abcdef" });
    expect(bearer).toMatchObject({ status: 401, body: { error: expect.stringMatching(/shared operator token no longer authorizes/) } });
    expect((await call("GET", "snapshots", undefined, "alice", { "x-gha-emergency": "" })).status).toBe(403);
    expect((await call("GET", "snapshots")).status).toBe(200);
  });

  it("signs in with the authorization code flow and PKCE, into an HttpOnly, Secure, SameSite=Strict session cookie", async () => {
    const { api, call } = await setup();
    const login = await api({ method: "GET", path: "auth/login", query: new URLSearchParams({ return: "#/emergency/executions/0123456789abcdef" }), headers: {} });
    expect(login.status).toBe(302);
    const to = new URL(String(login.headers!.Location));
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, code_challenge_method: "S256", scope: "openid profile email" });
    expect([login.headers!["Set-Cookie"]].flat()[0]).toMatch(/^__Host-gha-emergency-login=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const binding = setCookie(login, LOGIN_COOKIE)!;
    const back = await api({ method: "GET", path: "auth/callback", query: await IDP.authorize(to.toString(), "alice"), headers: { cookie: `${LOGIN_COOKIE}=${binding}` } });
    expect(back.headers!.Location).toBe("/#/emergency/executions/0123456789abcdef");
    const session = [back.headers!["Set-Cookie"]].flat().find((c) => c?.startsWith(SESSION_COOKIE));
    expect(session).toMatch(/^__Host-gha-emergency-session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800$/);
    // The executor exchanged the code itself, with the PKCE verifier; the browser never saw a token.
    expect(new URLSearchParams(IDP.tokenRequests.at(-1)!.body).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const me = (await call("GET", "auth/session")).body;
    expect(me).toMatchObject({ user: { id: uid("alice"), name: "alice", issuer: ISS, subject: "alice" }, roles: ["operator"], session: { method: "oidc" } });
    expect(JSON.stringify(me)).not.toMatch(/id_token|access_token|eyJ/);
  });

  const badTokens: [string, Parameters<typeof IDP.tamper>[0], RegExp][] = [
    ["signed with a key the provider doesn't publish", { foreignKey: true }, /signature is not valid/],
    ['algorithm "none"', { alg: "none" }, /algorithm "none" is not allowed/],
    ["HMAC with a guessable secret", { alg: "HS256" }, /algorithm "HS256" is not allowed/],
    ["for another application (audience)", { claims: { aud: "another-app" } }, /not for this application/],
    ["from another issuer", { claims: { iss: "https://evil.example" } }, /issued by "https:\/\/evil.example"/],
    ["expired", { claims: { exp: Math.floor(NOW.getTime() / 1000) - 3600 } }, /expired/],
    ["issued in the future", { claims: { iat: Math.floor(NOW.getTime() / 1000) + 3600, exp: Math.floor(NOW.getTime() / 1000) + 7200 } }, /issued in the future/],
    ["for another sign-in (nonce)", { claims: { nonce: "someone-elses" } }, /nonce does not match/],
    ["without a subject", { claims: { sub: "" } }, /no valid subject/],
    ["with several audiences and another authorized party", { claims: { aud: [CLIENT, "other"], azp: "other" } }, /authorized party/],
  ];
  for (const [what, tamper, reason] of badTokens) {
    it(`refuses an ID token ${what}`, async () => {
      const { api, audit } = await setup();
      const login = await api({ method: "GET", path: "auth/login", headers: {} });
      const query = await IDP.authorize(String(login.headers!.Location), "alice");
      IDP.tamper(tamper);
      const back = await api({ method: "GET", path: "auth/callback", query, headers: { cookie: `${LOGIN_COOKIE}=${setCookie(login, LOGIN_COOKIE)}` } });
      expect(back.headers!.Location).toBe("/#/emergency/sign-in-failed");
      expect(setCookie(back, SESSION_COOKIE)).toBeUndefined();
      expect(audit.at(-1)).toMatchObject({ action: "sign-in-failed", reason: expect.stringMatching(reason) });
    });
  }

  it("refuses a callback that isn't this browser's sign-in, a replayed code, and a provider error", async () => {
    const { api } = await setup();
    const failed = (r: ApiResponse) => r.headers!.Location === "/#/emergency/sign-in-failed" && setCookie(r, SESSION_COOKIE) === undefined;
    const a = await api({ method: "GET", path: "auth/login", headers: {} });
    const b = await api({ method: "GET", path: "auth/login", headers: {} });
    const qa = await IDP.authorize(String(a.headers!.Location), "alice");
    // No sign-in cookie (login CSRF: an attacker's code pushed into the victim's browser).
    expect(failed(await api({ method: "GET", path: "auth/callback", query: qa, headers: {} }))).toBe(true);
    // Another sign-in's cookie: the state doesn't match.
    expect(failed(await api({ method: "GET", path: "auth/callback", query: qa, headers: { cookie: `${LOGIN_COOKIE}=${setCookie(b, LOGIN_COOKIE)}` } }))).toBe(true);
    // The right cookie, used once; the same code and cookie again are refused.
    const c = await api({ method: "GET", path: "auth/login", headers: {} });
    const qc = await IDP.authorize(String(c.headers!.Location), "alice");
    const cookie = `${LOGIN_COOKIE}=${setCookie(c, LOGIN_COOKIE)}`;
    expect(failed(await api({ method: "GET", path: "auth/callback", query: qc, headers: { cookie } }))).toBe(false);
    expect(failed(await api({ method: "GET", path: "auth/callback", query: qc, headers: { cookie } }))).toBe(true);
    const d = await api({ method: "GET", path: "auth/login", headers: {} });
    const state = new URL(String(d.headers!.Location)).searchParams.get("state")!;
    expect(failed(await api({ method: "GET", path: "auth/callback", query: new URLSearchParams({ state, error: "access_denied" }), headers: { cookie: `${LOGIN_COOKIE}=${setCookie(d, LOGIN_COOKIE)}` } }))).toBe(true);
    // An open redirect through "return" is not possible.
    const e = await api({ method: "GET", path: "auth/login", query: new URLSearchParams({ return: "https://evil.example/" }), headers: {} });
    const back = await api({ method: "GET", path: "auth/callback", query: await IDP.authorize(String(e.headers!.Location), "alice"), headers: { cookie: `${LOGIN_COOKIE}=${setCookie(e, LOGIN_COOKIE)}` } });
    expect(back.headers!.Location).toBe("/#/emergency");
  });

  it("takes roles only from the executor's records: a forged role claim in the ID token grants nothing", async () => {
    const { api, call, audit } = await setup();
    const login = await api({ method: "GET", path: "auth/login", headers: {} });
    const query = await IDP.authorize(String(login.headers!.Location), "mallory");
    IDP.tamper({ claims: { roles: ["administrator"], groups: ["gha-emergency-administrators"], "https://gha/roles": ["approver"] } });
    const back = await api({ method: "GET", path: "auth/callback", query, headers: { cookie: `${LOGIN_COOKIE}=${setCookie(login, LOGIN_COOKIE)}` } });
    const cookie = `${SESSION_COOKIE}=${setCookie(back, SESSION_COOKIE)}`;
    const me = await api({ method: "GET", path: "auth/session", headers: { "x-gha-emergency": "1", cookie } });
    expect(me.body).toMatchObject({ roles: [], permissions: [] });
    for (const path of ["admin/users", "snapshots", "executions"]) expect((await api({ method: "GET", path, headers: { "x-gha-emergency": "1", cookie } })).status).toBe(403);
    expect(audit.find((a) => a.action === "signed-in" && (a.by as { name: string }).name === "mallory")).toMatchObject({ roles: [] });
    expect((await call("GET", "snapshots", undefined, "dave")).status).toBe(200);
  });

  it("expires sessions (absolute and idle limits) and lets users and administrators revoke them", async () => {
    const { call } = await setup();
    expect((await call("GET", "snapshots")).status).toBe(200);
    clock = new Date(NOW.getTime() + 59 * 60_000);
    expect((await call("GET", "snapshots")).status).toBe(200);
    clock = new Date(clock.getTime() + 61 * 60_000);
    expect((await call("GET", "snapshots")).status).toBe(401);
    // Absolute: 8 hours even when used every few minutes.
    const s2 = await setup();
    clock = NOW;
    for (let m = 0; m < 8 * 60; m += 50) {
      clock = new Date(NOW.getTime() + m * 60_000);
      expect((await s2.call("GET", "snapshots", undefined, "bob")).status).toBe(200);
    }
    clock = new Date(NOW.getTime() + 8 * 3_600_000 + 1);
    expect((await s2.call("GET", "snapshots", undefined, "bob")).status).toBe(401);
  });

  it("signing out, an administrator's revocation and disabling a user end sessions at once", async () => {
    const { call, audit } = await setup();
    expect((await call("POST", "auth/logout", {})).status).toBe(200);
    expect((await call("GET", "snapshots")).status).toBe(401);
    const t = await setup();
    expect((await t.call("GET", "snapshots", undefined, "bob")).status).toBe(200);
    expect((await t.call("POST", `admin/users/${uid("bob")}/revoke-sessions`, {}, "root")).body).toEqual({ revoked: 1 });
    expect((await t.call("GET", "snapshots", undefined, "bob")).status).toBe(401);
    const u = await setup();
    expect((await u.call("GET", "snapshots", undefined, "erin")).status).toBe(200);
    expect((await u.call("POST", `admin/users/${uid("erin")}/disable`, {}, "root")).status).toBe(200);
    expect((await u.call("GET", "snapshots", undefined, "erin")).status).toBe(401);
    await expect(u.signIn("erin")).rejects.toThrow(/sign-in failed/);
    expect(audit.some((a) => a.action === "signed-out")).toBe(true);
  });

  it("break-glass: separate named accounts with pinned roles, a reason, short sessions, and a lockout", async () => {
    const { api, audit } = await setup();
    const bg = (account: string, credential: string, reason = "IdP outage INC-1234, approved by on-call lead") =>
      api({ method: "POST", path: "auth/break-glass", headers: { "x-gha-emergency": "1", "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ account, credential, reason })) });
    expect((await bg("recovery-1", BREAK_GLASS["recovery-1"]!, "short")).status).toBe(422);
    const ok = await bg("recovery-1", BREAK_GLASS["recovery-1"]!);
    expect(ok.status).toBe(200);
    const cookie = `${SESSION_COOKIE}=${setCookie(ok, SESSION_COOKIE)}`;
    expect([ok.headers!["Set-Cookie"]].flat()[0]).toMatch(/Max-Age=3600$/);
    const me = (await api({ method: "GET", path: "auth/session", headers: { "x-gha-emergency": "1", cookie } })).body as any;
    expect(me).toMatchObject({ user: { id: "bg-recovery-1", kind: "break-glass" }, roles: ["operator"], session: { method: "break-glass" } });
    expect(audit.find((a) => a.action === "signed-in" && a.method === "break-glass")).toMatchObject({ reason: "IdP outage INC-1234, approved by on-call lead" });
    clock = new Date(NOW.getTime() + 61 * 60_000);
    expect((await api({ method: "GET", path: "snapshots", headers: { "x-gha-emergency": "1", cookie } })).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await bg("recovery-2", "wrong-credential-wrong-credential-wrong")).status).toBe(401);
    expect((await bg("recovery-2", BREAK_GLASS["recovery-2"]!)).body).toMatchObject({ error: expect.stringMatching(/Too many failed attempts/) });
    expect((await bg("no-such-account", "x".repeat(40))).status).toBe(401);
    expect(JSON.stringify(audit)).not.toContain(BREAK_GLASS["recovery-1"]);
  });
});

describe("security review H2: role-based authorization", () => {
  it("a viewer reads, but can't upload, execute, verify, delete or run checks", async () => {
    const { call, boundDemo, jobs } = await setup();
    const id = await boundDemo();
    expect((await call("GET", "snapshots", undefined, "dave")).status).toBe(200);
    expect((await call("GET", `snapshots/${id}`, undefined, "dave")).status).toBe(200);
    expect((await call("GET", "network-check", undefined, "dave")).status).toBe(200);
    expect((await call("POST", "snapshots", await bundle({ "x.txt": "y" }), "dave")).status).toBe(403);
    expect((await call("POST", "executions", run(id), "dave")).status).toBe(403);
    expect((await call("POST", `snapshots/${id}/verify`, {}, "dave")).status).toBe(403);
    expect((await call("DELETE", `snapshots/${id}`, undefined, "dave")).status).toBe(403);
    expect((await call("POST", "network-check", {}, "dave")).status).toBe(403);
    expect(jobs.size).toBe(0);
  });

  it("an operator can't administer: users, roles, sessions, bindings and the audit log are refused", async () => {
    const { call, audit } = await setup();
    for (const [m, path, body] of [["GET", "admin/users"], ["PUT", `admin/users/${uid("bob")}/roles`, { roles: ["administrator"] }], ["POST", `admin/users/${uid("bob")}/disable`, {}], ["POST", `admin/users/${uid("bob")}/revoke-sessions`, {}], ["GET", "admin/bindings"], ["PUT", "admin/bindings/release-demo", { suspended: true, reason: "because" }], ["GET", "admin/audit"]] as [string, string, unknown][]) {
      const r = await call(m, path, body);
      expect([path, r.status]).toEqual([path, 403]);
    }
    expect(denials(audit).every((d) => (d.by as { name: string }).name === "alice")).toBe(true);
  });

  it("nobody grants themselves a role; administrators manage others' roles, and changes apply at once and are audited", async () => {
    const { call, audit } = await setup();
    // An operator can't, by any route.
    expect((await call("PUT", `admin/users/${uid("alice")}/roles`, { roles: ["operator", "administrator"] })).status).toBe(403);
    // An administrator can't change their own roles either, nor disable themselves.
    await call("GET", "auth/session", undefined, "root");
    expect((await call("PUT", `admin/users/${uid("root")}/roles`, { roles: ["operator", "approver"] }, "root")).body).toMatchObject({ details: ["You can't change your own roles"] });
    expect((await call("POST", `admin/users/${uid("root")}/disable`, {}, "root")).status).toBe(403);
    // Pinned administrators keep their role; others' roles change at the next request, without signing in again.
    expect((await call("GET", "admin/users", undefined, "root")).body.users.find((u: any) => u.id === uid("root"))).toMatchObject({ effectiveRoles: ["administrator"], pinnedRoles: ["administrator"] });
    expect((await call("GET", "executions", undefined, "dave")).status).toBe(200);
    expect((await call("PUT", `admin/users/${uid("dave")}/roles`, { roles: [] }, "root")).status).toBe(200);
    expect((await call("GET", "executions", undefined, "dave")).status).toBe(403);
    expect((await call("PUT", `admin/users/${uid("dave")}/roles`, { roles: ["superuser"] }, "root")).status).toBe(422);
    expect(audit.find((a) => a.action === "roles-changed")).toMatchObject({ by: { id: uid("root") }, user: { id: uid("dave") }, before: ["viewer"], after: [] });
    expect((await call("PUT", "admin/users/u-000000000000000000000000/roles", { roles: ["viewer"] }, "root")).status).toBe(404);
  });

  it("restricted snapshots: invisible to other operators and viewers by ID, listing or name; run only by their preparer", async () => {
    const { call, bindings } = await setup();
    const up = await call("POST", "snapshots", { ...(await bundle({ "docs/restricted.txt": "x\n" })), visibility: "restricted" }, "bob");
    expect(up.body.snapshot).toMatchObject({ visibility: "restricted", preparedBy: { id: uid("bob"), name: "bob" } });
    const id = up.body.snapshot.id as string;
    bindings.push({ name: "release-demo", secret: "demo-secrets", keys: ["DEMO_SIGNING_KEY"], snapshots: [id] });
    for (const who of ["alice", "dave"]) {
      expect((await call("GET", "snapshots", undefined, who)).body.snapshots.map((s: any) => s.id)).not.toContain(id);
      expect((await call("GET", `snapshots/${id}`, undefined, who)).status).toBe(404);
    }
    expect((await call("POST", `snapshots/${id}/verify`, {}, "alice")).status).toBe(404);
    expect((await call("POST", "executions", run(id), "alice")).status).toBe(404);
    expect((await call("DELETE", `snapshots/${id}`, undefined, "alice")).status).toBe(404);
    // Uploading the same content doesn't reveal or take it over; a new version under its name is refused.
    expect((await call("POST", "snapshots", await bundle({ "docs/restricted.txt": "x\n" }), "alice")).status).toBe(409);
    expect((await call("POST", "snapshots", await bundle({ "docs/restricted.txt": "y\n" }), "alice")).body.details[0].message).toMatch(/belongs to a restricted snapshot prepared by someone else/);
    // Approvers and administrators see it (approvers review what they approve); only bob runs it.
    expect((await call("GET", `snapshots/${id}`, undefined, "carol")).status).toBe(200);
    expect((await call("GET", `snapshots/${id}`, undefined, "root")).status).toBe(200);
    const exec = await call("POST", "executions", run(id), "bob");
    expect(exec.status).toBe(201);
    expect((await call("GET", `executions/${exec.body.execution.id}`, undefined, "alice")).status).toBe(404);
    expect((await call("GET", "executions", undefined, "alice")).body.executions).toEqual([]);
    expect((await call("DELETE", `executions/${exec.body.execution.id}`, undefined, "alice")).status).toBe(404);
    expect((await call("GET", `executions/${exec.body.execution.id}`, undefined, "carol")).status).toBe(200);
  });

  it("ownership comes from the session, never from the request: claimed preparers, initiators and approvals are ignored", async () => {
    const { call, jobs, bindings } = await setup();
    const up = await call("POST", "snapshots", { ...(await bundle()), preparedBy: { id: uid("root"), name: "root" }, visibility: "shared" });
    expect(up.body.snapshot.preparedBy).toEqual({ id: uid("alice"), name: "alice" });
    bindings.push({ name: "release-demo", secret: "demo-secrets", keys: ["DEMO_SIGNING_KEY"], snapshots: [up.body.snapshot.id] });
    const exec = await call("POST", "executions", { ...run(up.body.snapshot.id), initiatedBy: { id: uid("carol"), name: "carol" }, approval: { decidedBy: { id: uid("carol") } }, state: "started", secretName: "operator" });
    expect(exec.status).toBe(422);
    expect(exec.body.details.join()).toMatch(/secretName can't be chosen/);
    const ok = await call("POST", "executions", { ...run(up.body.snapshot.id), initiatedBy: { id: uid("carol"), name: "carol" }, approval: { decidedBy: { id: uid("carol") } }, state: "approved" });
    expect(ok.status).toBe(201);
    expect(ok.body.execution).toMatchObject({ initiatedBy: { id: uid("alice"), name: "alice" }, state: "started" });
    expect(ok.body.execution.approval).toBeUndefined();
    expect(jobs.size).toBe(1);
  });

  it("only its preparer or an administrator deletes a snapshot; only its initiator or an administrator stops an execution", async () => {
    const { call, boundDemo, jobs } = await setup();
    const id = await boundDemo();
    expect((await call("DELETE", `snapshots/${id}`, undefined, "bob")).status).toBe(403);
    const exec = (await call("POST", "executions", run(id))).body.execution;
    expect((await call("DELETE", `executions/${exec.id}`, undefined, "bob")).status).toBe(403);
    expect(jobs.size).toBe(1);
    expect((await call("DELETE", `executions/${exec.id}`, undefined, "root")).status).toBe(200);
    expect(jobs.size).toBe(0);
    expect((await call("DELETE", `snapshots/${id}`, undefined, "root")).status).toBe(200);
  });

  it("Secret bindings: only administrators suspend or resume them, and nobody creates or widens one through the API", async () => {
    const { call, boundDemo, audit } = await setup();
    const id = await boundDemo();
    expect((await call("PUT", "admin/bindings/release-demo", { suspended: true, reason: "rotate" })).status).toBe(403);
    expect((await call("POST", "admin/bindings/new-binding", { secret: "prod-db", keys: ["PASSWORD"], snapshots: [id] }, "root")).status).toBe(405);
    expect((await call("DELETE", "admin/bindings/release-demo", undefined, "root")).status).toBe(405);
    expect((await call("PUT", "admin/bindings/not-configured", { suspended: false, reason: "resume it" }, "root")).status).toBe(404);
    expect((await call("PUT", "admin/bindings/release-demo", { suspended: true, reason: "key rotation" }, "root")).status).toBe(200);
    expect((await call("POST", "executions", run(id))).body.details).toEqual(["The Secret binding release-demo is suspended by an administrator"]);
    expect((await call("PUT", "admin/bindings/release-demo", { suspended: false, reason: "rotated" }, "root")).status).toBe(200);
    expect((await call("POST", "executions", run(id))).status).toBe(201);
    expect(audit.filter((a) => String(a.action).startsWith("binding-")).map((a) => a.action)).toEqual(["binding-suspended", "binding-resumed"]);
  });

  it("administrators read the attributed audit log; it never holds session tokens or event keys", async () => {
    const { call, boundDemo, sessionOf } = await setup();
    const id = await boundDemo();
    await call("POST", "executions", run(id));
    const entries = (await call("GET", "admin/audit", undefined, "root")).body.entries as any[];
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(["signed-in", "snapshot-stored", "execution-started"]));
    expect(entries.find((e) => e.action === "execution-started")).toMatchObject({ by: { name: "alice" } });
    expect(JSON.stringify(entries)).not.toContain(await sessionOf("alice"));
  });
});

describe("security review H2: execution approval", () => {
  const POLICY: ApprovalPolicy = { requireFor: ["secrets", "egress"], separationOfDuties: true, ttlMinutes: 60 };

  async function requested(opts: SetupOptions = {}) {
    const ctx = await setup({ approval: POLICY, ...opts });
    const id = await ctx.boundDemo();
    const r = await ctx.call("POST", "executions", run(id, { inputs: { version: "4.2.0" } }));
    return { ...ctx, id, r, exec: r.body.execution };
  }

  it("a sensitive execution (it receives a Secret) waits for approval, with no Job; a harmless one runs at once", async () => {
    const t = await requested();
    expect(t.r.status).toBe(202);
    expect(t.exec).toMatchObject({ state: "awaiting-approval", initiatedBy: { id: uid("alice") }, preparedBy: { id: uid("alice") }, approval: { reasons: [expect.stringMatching(/receives DEMO_SIGNING_KEY from Secret demo-secrets/)], requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(t.jobs.size).toBe(0);
    expect((await t.call("GET", `executions/${t.exec.id}`, undefined, "dave")).body).toMatchObject({ job: { state: "not-started" }, view: { status: "pending", reason: "Waiting for an approver" } });
    // No Secret, isolated: no approval needed under the default policy.
    const harmless = await t.call("POST", "snapshots", await bundle({ ".github/workflows/release.yml": "on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo hello\n" }));
    expect((await t.call("POST", "executions", { snapshotId: harmless.body.snapshot.id, workflow: WORKFLOW })).status).toBe(201);
  });

  it("an approver approves exactly the reviewed request; the Job starts, attributed to preparer, initiator and approver", async () => {
    const t = await requested();
    const r = await t.call("POST", `executions/${t.exec.id}/approve`, { decision: "approve", requestDigest: t.exec.approval.requestDigest, comment: "release 4.2.0, change CHG-77" }, "carol");
    expect(r.status).toBe(201);
    expect(r.body.execution).toMatchObject({ state: "started", initiatedBy: { name: "alice" }, preparedBy: { name: "alice" }, approval: { decision: "approved", decidedBy: { id: uid("carol"), name: "carol" }, comment: "release 4.2.0, change CHG-77" }, secretName: "demo-secrets" });
    expect(r.body.execution.decisions.map((d: any) => `${d.decision}:${d.by.name}`)).toEqual(["requested:alice", "approved:carol", "started:carol"]);
    expect(t.jobs.size).toBe(1);
    expect(t.audit.find((a) => a.action === "execution-started")).toMatchObject({ initiatedBy: { name: "alice" }, approvedBy: { name: "carol" } });
  });

  it("refuses approval by users without the approver role, and by the initiator or preparer (separation of duties)", async () => {
    const t = await requested();
    const body = { decision: "approve", requestDigest: t.exec.approval.requestDigest };
    expect((await t.call("POST", `executions/${t.exec.id}/approve`, body, "bob")).status).toBe(403);
    expect((await t.call("POST", `executions/${t.exec.id}/approve`, body, "dave")).status).toBe(403);
    // alice is given the approver role too: still not for her own request.
    t.authStore.setRoles(uid("alice"), ["operator", "approver"], "test-fixture");
    expect((await t.call("POST", `executions/${t.exec.id}/approve`, body, "alice")).body.details[0]).toMatch(/Separation of duties/);
    // bob requests a run of alice's snapshot: alice prepared it, so she can't approve that either.
    const bobs = (await t.call("POST", "executions", run(t.id), "bob")).body.execution;
    expect((await t.call("POST", `executions/${bobs.id}/approve`, { decision: "approve", requestDigest: bobs.approval.requestDigest }, "alice")).body.details[0]).toMatch(/Separation of duties/);
    expect(t.jobs.size).toBe(0);
    // Without separation of duties (configurable), a dual-role user may.
    const lax = await requested({ approval: { ...POLICY, separationOfDuties: false } });
    lax.authStore.setRoles(uid("alice"), ["operator", "approver"], "test-fixture");
    expect((await lax.call("POST", `executions/${lax.exec.id}/approve`, { decision: "approve", requestDigest: lax.exec.approval.requestDigest }, "alice")).status).toBe(201);
  });

  it("an approval can't be replayed: another request's digest, a changed binding or an expired request invalidate it", async () => {
    const t = await requested();
    const other = (await t.call("POST", "executions", run(t.id, { inputs: { version: "9.9.9-evil" } }))).body.execution;
    expect(other.approval.requestDigest).not.toBe(t.exec.approval.requestDigest);
    // The digest the approver reviewed (4.2.0) presented for the other request (9.9.9-evil): refused.
    expect((await t.call("POST", `executions/${other.id}/approve`, { decision: "approve", requestDigest: t.exec.approval.requestDigest }, "carol")).status).toBe(409);
    expect(t.audit.some((a) => a.action === "approval-mismatch")).toBe(true);
    // The binding changes after the request (another key): the request is invalidated, not approved.
    t.bindings[0]!.keys = ["DEMO_SIGNING_KEY", "EXTRA"];
    t.bindings[0]!.secret = "prod-secrets";
    const changed = await t.call("POST", `executions/${t.exec.id}/approve`, { decision: "approve", requestDigest: t.exec.approval.requestDigest }, "carol");
    expect(changed).toMatchObject({ status: 409, body: { details: [expect.stringMatching(/changed since it was requested/)] } });
    expect((await t.call("GET", `executions/${t.exec.id}`)).body.meta.state).toBe("invalidated");
    // Expiry.
    const u = await requested();
    clock = new Date(NOW.getTime() + 61 * 60_000);
    expect((await u.call("POST", `executions/${u.exec.id}/approve`, { decision: "approve", requestDigest: u.exec.approval.requestDigest }, "carol")).body.error).toMatch(/expired/);
    expect(t.jobs.size + u.jobs.size).toBe(0);
  });

  it("a binding suspended after approval stops the start and invalidates the approval", async () => {
    const t = await requested({ admission: "unverified" });
    // Approved while the admission check fails: the approval stands, the Job doesn't start.
    const approved = await t.call("POST", `executions/${t.exec.id}/approve`, { decision: "approve", requestDigest: t.exec.approval.requestDigest }, "carol");
    expect(approved.body).toMatchObject({ execution: { state: "approved" }, startProblem: { error: expect.stringMatching(/admission policy/) } });
    t.bindingState.set("release-demo", { suspended: true, by: { id: "x", name: "x" }, at: NOW.toISOString(), reason: "incident" });
    expect((await t.call("POST", `executions/${t.exec.id}/start`, {}, "bob")).status).toBe(403);
    expect((await t.call("POST", `executions/${t.exec.id}/start`, {})).body).toMatchObject({ details: [expect.stringMatching(/suspended/)] });
    expect((await t.call("GET", `executions/${t.exec.id}`)).body.meta.state).toBe("invalidated");
    expect(t.jobs.size).toBe(0);
  });

  it("a rejection is final", async () => {
    const u = await requested();
    expect((await u.call("POST", `executions/${u.exec.id}/approve`, { decision: "reject", requestDigest: u.exec.approval.requestDigest, comment: "not during the freeze" }, "carol")).body.execution).toMatchObject({ state: "rejected", approval: { decidedBy: { name: "carol" } } });
    expect((await u.call("POST", `executions/${u.exec.id}/start`, {})).status).toBe(409);
    expect((await u.call("POST", `executions/${u.exec.id}/approve`, { decision: "approve", requestDigest: u.exec.approval.requestDigest }, "erin")).status).toBe(409);
    expect(u.jobs.size).toBe(0);
  });

  it("an approved execution blocked by a cluster check is started later by its initiator only", async () => {
    const t = await requested({ admission: "unverified" });
    await t.call("POST", `executions/${t.exec.id}/approve`, { decision: "approve", requestDigest: t.exec.approval.requestDigest }, "carol");
    t.adm.checker.ensureFresh = async () => ({ state: "enforced", checkedAt: NOW.toISOString() });
    expect((await t.call("POST", `executions/${t.exec.id}/start`, {}, "bob")).status).toBe(403);
    expect((await t.call("POST", `executions/${t.exec.id}/start`, {}, "root")).status).toBe(403);
    const started = await t.call("POST", `executions/${t.exec.id}/start`, {});
    expect(started).toMatchObject({ status: 201, body: { execution: { state: "started", approval: { decidedBy: { name: "carol" } } } } });
    expect((await t.call("POST", `executions/${t.exec.id}/start`, {})).status).toBe(409);
  });

  it("break-glass accounts can complete the flow during an identity-provider outage, as two different people", async () => {
    const t = await requested();
    const bg = async (account: string) => {
      const r = await t.api({ method: "POST", path: "auth/break-glass", headers: { "x-gha-emergency": "1", "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ account, credential: BREAK_GLASS[account], reason: "IdP outage INC-1234" })) });
      return `${SESSION_COOKIE}=${setCookie(r, SESSION_COOKIE)}`;
    };
    const as = (cookie: string, method: string, path: string, body?: unknown) => t.api({ method, path, headers: { "x-gha-emergency": "1", "content-type": "application/json", cookie }, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)) });
    const operator = await bg("recovery-1");
    const approver = await bg("recovery-2");
    const req = (await as(operator, "POST", "executions", run(t.id))).body as any;
    expect(req.execution).toMatchObject({ state: "awaiting-approval", initiatedBy: { id: "bg-recovery-1" } });
    expect((await as(operator, "POST", `executions/${req.execution.id}/approve`, { decision: "approve", requestDigest: req.execution.approval.requestDigest })).status).toBe(403);
    expect((await as(approver, "POST", `executions/${req.execution.id}/approve`, { decision: "approve", requestDigest: req.execution.approval.requestDigest })).status).toBe(201);
  });
});

// Security review M4: runner pods are isolated from the trusted executor by an explicit, enforced mode. These tests
// prove the Job-spec placement and the fail-closed behaviour. They do NOT prove resistance to a node compromise:
// node-level isolation depends on the cluster actually honouring the node pool, taints and RuntimeClass.
describe("security review M4: runner isolation placement", () => {
  const labels = { app: "executor" };
  const runnerJob = (isolation: RunnerIsolation) => buildJob({ ...jobInput, isolation });

  it("colocated: pins the runner to the executor's node (shared ReadWriteOnce volume)", () => {
    const pod = runnerJob({ mode: "colocated" }).spec.template.spec as any;
    expect(pod.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels).toEqual(labels);
    expect(pod.affinity.podAntiAffinity).toBeUndefined();
    expect(pod.runtimeClassName).toBeUndefined();
  });

  it("sandbox: co-located but under a sandboxed RuntimeClass", () => {
    const pod = runnerJob({ mode: "sandbox", runtimeClass: "gvisor" }).spec.template.spec as any;
    expect(pod.runtimeClassName).toBe("gvisor");
    expect(pod.affinity.podAffinity).toBeDefined();
    expect(() => runnerJob({ mode: "sandbox" } as RunnerIsolation)).toThrow(RunnerIsolationError);
  });

  it("node: executions refuse node mode, because the shared RWO volume cannot span nodes (fail closed)", () => {
    expect(() => runnerJob({ mode: "node", nodeSelector: { pool: "runners" } })).toThrow(/ReadWriteMany|cannot be used/);
  });

  it("node: a pod that does not mount the shared volume is scheduled off the executor's node", () => {
    const place = placement({ mode: "node", nodeSelector: { pool: "runners" }, tolerations: [{ key: "runners", operator: "Exists", effect: "NoSchedule" }], runtimeClass: "gvisor" }, labels, false) as any;
    expect(place.nodeSelector).toEqual({ pool: "runners" });
    expect(place.tolerations).toHaveLength(1);
    expect(place.runtimeClassName).toBe("gvisor");
    expect(place.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels).toEqual(labels);
    expect(place.affinity.podAffinity).toBeUndefined();
    expect(() => placement({ mode: "node", nodeSelector: {} }, labels, false)).toThrow(/nodeSelector/);
  });

  it("fails closed when isolation is missing or unknown", () => {
    expect(() => placement(undefined, labels, true)).toThrow(RunnerIsolationError);
    expect(() => placement({ mode: "bogus" } as unknown as RunnerIsolation, labels, true)).toThrow(/Unknown runner isolation mode/);
    expect(() => buildJob({ ...jobInput, isolation: undefined as unknown as RunnerIsolation })).toThrow(RunnerIsolationError);
  });

  it("canary probes mirror the execution placement; the control pod stays co-located", () => {
    const probe = buildCanaryJob({ checkId: "c", role: "probe-isolated", targets: [], namespace: "ns", runnerImage: "img", serviceAccountName: "runner", executorPodLabels: labels, isolation: { mode: "sandbox", runtimeClass: "gvisor" } });
    expect((probe.spec.template.spec as any).runtimeClassName).toBe("gvisor");
    const control = buildCanaryJob({ checkId: "c", role: "control", targets: [], namespace: "ns", runnerImage: "img", serviceAccountName: "runner", executorPodLabels: labels, isolation: { mode: "node", nodeSelector: { pool: "runners" } } });
    // The control pod proves the network works from an ordinary node: it co-locates and ignores node mode.
    expect((control.spec.template.spec as any).affinity.podAffinity).toBeDefined();
    expect((control.spec.template.spec as any).nodeSelector).toBeUndefined();
  });
});
