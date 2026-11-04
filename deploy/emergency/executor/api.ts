// The executor's HTTP API under <base>api/emergency/, used by the UI's emergency view (same origin, so the app's CSP
// needs no change). The executor never contacts GitHub, never reads Kubernetes Secrets and never receives secret
// values: an execution names a Secret, which only the runner pod mounts.
//
// Security review H2: every operation except health and sign-in needs a session (auth/store.ts), established by
// signing in with the configured OpenID Connect provider (auth/oidc.ts) or, when enabled, a break-glass account. The
// session token is an HttpOnly, Secure, SameSite=Strict cookie the page's JavaScript can't read; every API request
// must also carry the header X-GHA-Emergency: 1, which another origin can't send without a CORS grant (there is none).
// Each operation needs a permission (auth/roles.ts), checked here, server-side, on every request; refusals are
// audited. Resources carry the identities that acted on them, and restricted snapshots and their executions are
// visible only to their preparer, approvers and administrators (others get 404, as for an unknown ID).
//
//   GET    health                          { available, signIn }                       (no session)
//   GET    auth/login?return=#/emergency…  redirect to the identity provider          (no session)
//   GET    auth/callback                   the provider's redirect back               (no session)
//   POST   auth/break-glass                { account, credential, reason }            (no session; when enabled)
//   GET    auth/session                    who you are, your roles and permissions
//   POST   auth/logout
//   GET    snapshots                       snapshots.read (restricted ones only where visible)
//   POST   snapshots                       snapshots.create  { manifest, contents, visibility? } → stored write-once
//   GET    snapshots/{id}                  snapshots.read
//   POST   snapshots/{id}/verify           snapshots.verify
//   DELETE snapshots/{id}                  snapshots.delete-own (preparer) or snapshots.delete-any
//   GET    executions                      executions.read
//   POST   executions                      executions.create  { snapshotId, workflow, inputs, variables, network }
//   GET    executions/{id}                 executions.read: status, jobs, steps, logs, outputs, attribution
//   POST   executions/{id}/approve         executions.approve  { decision, requestDigest, comment }
//   POST   executions/{id}/start           executions.create (its initiator): start an approved execution
//   DELETE executions/{id}                 executions.cancel-own (initiator) or executions.cancel-any
//   GET    network-check, admission-check  checks.read;  POST: checks.run
//   GET    admin/users                     admin.users
//   PUT    admin/users/{id}/roles          admin.users  { roles }   (never your own)
//   POST   admin/users/{id}/disable|enable admin.users             (never your own)
//   POST   admin/users/{id}/revoke-sessions admin.sessions
//   GET    admin/bindings                  admin.bindings;  PUT admin/bindings/{name} { suspended, reason }
//   GET    admin/audit                     admin.audit
//
// Secrets (security review C1): the Secret and the keys an execution receives come from the snapshot's binding
// (bindings.ts), keyed by snapshot digest and written by a cluster administrator; a request can't choose them.
// Network (C2): isolated executions run only after the canary has proved that NetworkPolicy is enforced.
// Admission (H4): no Job is created until the API server has proved it enforces the runner admission policy.
// Approval (H2): executions the configured policy marks as sensitive (by default: those that receive a Secret, or
// run in egress mode) wait for an approver's decision, bound to a digest of exactly what will run; any change to
// the snapshot's Secret binding invalidates it.
import { createHash, randomBytes } from "node:crypto";
import { judgeExecution, type EventVerification } from "../../../src/emergency/event-stream.ts";
import type { ExecutionView } from "../../../src/emergency/events.ts";
import type { Actor, SnapshotBundle, SnapshotRecord, Visibility } from "../../../src/emergency/snapshot.ts";
import type { AdmissionChecker } from "./admission-check.ts";
import type { AuditLog } from "./audit.ts";
import type { IdentityProvider } from "./auth/oidc.ts";
import { isRole, permissionsOf, ROLES, type Permission, type Role } from "./auth/roles.ts";
import { USER_ID, type AuthStore, type Principal } from "./auth/store.ts";
import { bindingFor, type BindingState, type SecretBinding } from "./bindings.ts";
import { buildJob, EXECUTION_LABEL, jobName, RUNNER_CONTAINER, type NetworkMode, type RunnerIsolation } from "./job-spec.ts";
import type { KubeApi, K8sJob } from "./kube.ts";
import type { NetworkChecker } from "./network-check.ts";
import type { ExecutionMeta, Store } from "./store.ts";

export type ApprovalTrigger = "secrets" | "egress" | "restricted" | "all";
export type ApprovalPolicy = {
  /** Which executions need approval: those receiving a Secret, in egress mode, of a restricted snapshot, or all. */
  requireFor: ApprovalTrigger[];
  /** The approver may be neither the initiator nor the snapshot's preparer. */
  separationOfDuties: boolean;
  /** How long a request waits for a decision, and an approval stays usable. */
  ttlMinutes: number;
};

export type ExecutorConfig = {
  namespace: string;
  runnerImage: string;
  pvcName: string;
  runnerServiceAccount: string;
  executorPodLabels: Record<string, string>;
  /** Where runner pods run relative to the executor (security review M4). */
  isolation: RunnerIsolation;
  resources: { cpu: string; memory: string; scratch: string };
  maxMinutes: number;
  /** Security review M6: characters of workflow log output the runner forwards, per step and per execution. */
  maxStepLogBytes: number;
  maxLogBytes: number;
  maxConcurrent: number;
  ttlSecondsAfterFinished: number;
  /** The Secret that holds break-glass credentials (formerly the operator token): never mountable by an execution. */
  operatorSecret: string;
  /** Egress mode (not isolated) is off unless an administrator enables it. */
  allowEgress: boolean;
  approval: ApprovalPolicy;
  /** Where the UI is served ("/" or "/sub/"): sign-in redirects back there. */
  uiBasePath: string;
};

export type ApiRequest = { method: string; path: string; query?: URLSearchParams; headers: Record<string, string | undefined>; body?: Buffer };
export type ApiResponse = { status: number; body?: unknown; headers?: Record<string, string | string[]> };

export const MAX_SNAPSHOT_BODY = 64 * 1024 * 1024;
export const MAX_SMALL_BODY = 64 * 1024;
export const SESSION_COOKIE = "__Host-gha-emergency-session";
export const LOGIN_COOKIE = "__Host-gha-emergency-login";
export const CSRF_HEADER = "x-gha-emergency";
const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETURN_TO = /^#\/emergency(\/[A-Za-z0-9/_-]*)?$/;

export type ExecutionStatus = {
  meta: ExecutionMeta;
  job: { state: "pending" | "running" | "succeeded" | "failed" | "missing" | "not-started"; reason?: string };
  view: ExecutionView;
};

export function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const setCookie = (name: string, value: string, opts: { maxAge?: number; sameSite: "Strict" | "Lax" }) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${opts.sameSite}${opts.maxAge !== undefined ? `; Max-Age=${opts.maxAge}` : ""}`;

const sortObject = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** The digest an approval is bound to: exactly what the execution will run, with which Secret keys, for whom. */
export function requestDigest(r: { id: string; snapshotId: string; workflow: string; inputs: Record<string, string>; variables: Record<string, string>; network: string; secret?: { binding: string; name: string; keys: string[] }; initiatedBy: string }): string {
  const canonical = JSON.stringify({
    execution: r.id,
    snapshot: r.snapshotId,
    workflow: r.workflow,
    inputs: sortObject(r.inputs),
    variables: sortObject(r.variables),
    network: r.network,
    secret: r.secret ? { binding: r.secret.binding, name: r.secret.name, keys: [...r.secret.keys].sort() } : null,
    initiatedBy: r.initiatedBy,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function createApi(deps: {
  store: Store;
  kube: KubeApi;
  config: ExecutorConfig;
  network: NetworkChecker;
  /** Proof that the API server enforces the runner admission policy (security review H4). */
  admission: AdmissionChecker;
  /** Current Secret bindings (read for every request, so ConfigMap updates apply without a restart). */
  loadBindings: () => { bindings: SecretBinding[]; problems: string[] };
  bindingState: BindingState;
  auth: { store: AuthStore; provider?: IdentityProvider; breakGlass: boolean };
  audit: AuditLog;
  now?: () => Date;
}) {
  const { store, kube, config, network: networkCheck, admission, audit } = deps;
  const users = deps.auth.store;
  const now = deps.now ?? (() => new Date());
  const json = (status: number, body: unknown, headers?: ApiResponse["headers"]): ApiResponse => ({ status, body, headers });
  const err = (status: number, message: string, details?: unknown): ApiResponse => json(status, { error: message, ...(details ? { details } : {}) });
  const redirect = (location: string, setCookies: string[] = []): ApiResponse => ({ status: 302, headers: { Location: location, "Set-Cookie": setCookies } });
  const actor = (p: Principal): Actor => ({ id: p.user.id, name: p.user.name });
  const uiUrl = (fragment: string) => `${config.uiBasePath}${fragment}`;

  const parseJson = (r: ApiRequest): unknown => {
    if (!/^application\/json\b/i.test(r.headers["content-type"] ?? "")) throw new RequestError(415, "Content-Type must be application/json");
    try {
      return JSON.parse(r.body?.toString("utf8") ?? "");
    } catch {
      throw new RequestError(400, "Body is not valid JSON");
    }
  };

  // ---- authorization ----------------------------------------------------------------------------------------------

  const has = (p: Principal, perm: Permission) => permissionsOf(p.roles).has(perm);
  const hasRole = (p: Principal, ...roles: Role[]) => roles.some((r) => p.roles.includes(r));
  /** A refusal, audited with who asked for what. */
  const denied = (p: Principal | undefined, action: string, reason: string, status = 403, target?: Record<string, unknown>): ApiResponse => {
    audit.write({ action: "authorization-denied", attempted: action, by: p ? actor(p) : null, reason, ...(target ?? {}) });
    return err(status, status === 401 ? "Sign-in required" : "Not permitted", [reason]);
  };
  const need = (p: Principal, perm: Permission, action: string, target?: Record<string, unknown>): ApiResponse | null => (has(p, perm) ? null : denied(p, action, `This needs the ${perm} permission, which your roles (${p.roles.join(", ") || "none"}) don't grant`, 403, target));

  const snapshotVisible = (p: Principal, r: Pick<SnapshotRecord, "visibility" | "preparedBy">) => r.visibility !== "restricted" || r.preparedBy?.id === p.user.id || hasRole(p, "approver", "administrator");
  const executionVisible = (p: Principal, m: ExecutionMeta) => m.visibility !== "restricted" || m.initiatedBy?.id === p.user.id || m.preparedBy?.id === p.user.id || hasRole(p, "approver", "administrator");

  // ---- Secret bindings --------------------------------------------------------------------------------------------

  function secretBindingFor(snapshotId: string): { binding?: SecretBinding; problem?: string } {
    const { bindings, problems } = deps.loadBindings();
    if (problems.length) return { problem: `Secret bindings are invalid, so none apply: ${problems.join("; ")}` };
    const found = bindingFor(bindings, snapshotId);
    if (found.binding && deps.bindingState.suspended(found.binding.name)) return { problem: `The Secret binding ${found.binding.name} is suspended by an administrator` };
    return found;
  }

  /** The Secret an execution of this snapshot receives now, or why it can't. */
  function resolveSecret(snapshotId: string, required: string[]): { secret?: { binding: string; name: string; keys: string[] }; problem?: string } {
    if (!required.length) return {};
    const { binding, problem } = secretBindingFor(snapshotId);
    if (problem) return { problem };
    if (!binding) return { problem: `No Secret is bound to this snapshot. A cluster administrator must bind a Secret with ${required.join(", ")} to digest ${snapshotId} (chart value secretBindings)` };
    if (binding.secret === config.operatorSecret || !K8S_NAME.test(binding.secret)) return { problem: "The bound Secret is not allowed" };
    const missing = required.filter((k) => !binding.keys.includes(k));
    if (missing.length) return { problem: `The binding ${binding.name} does not permit ${missing.join(", ")}` };
    return { secret: { binding: binding.name, name: binding.secret, keys: required } };
  }

  // ---- execution status -------------------------------------------------------------------------------------------

  const networkView = () => ({ ...networkCheck.status(), allowEgress: config.allowEgress });
  const verification = (meta: ExecutionMeta): EventVerification => {
    const key = store.eventKey(meta.id);
    if (key) return { kind: "hmac", key };
    return meta.eventAuth === "ed25519" ? { kind: "ed25519", execution: meta.id } : { kind: "legacy" };
  };
  const stateOf = (meta: ExecutionMeta) => meta.state ?? "started";

  async function status(meta: ExecutionMeta): Promise<ExecutionStatus> {
    const st = stateOf(meta);
    if (st !== "started") {
      const view: ExecutionView = { status: st === "awaiting-approval" || st === "approved" ? "pending" : "cancelled", network: [], jobs: [], logs: [], annotations: [], outputs: {} };
      const why: Record<string, string> = {
        "awaiting-approval": "Waiting for an approver",
        approved: "Approved; not started yet",
        rejected: `Rejected by ${meta.approval?.decidedBy?.name ?? "an approver"}`,
        cancelled: "Cancelled before it started",
        invalidated: "The approval request was invalidated",
      };
      view.reason = meta.decisions?.at(-1)?.reason && st === "invalidated" ? meta.decisions.at(-1)!.reason : why[st];
      return { meta, job: { state: "not-started", reason: view.reason }, view };
    }
    const archived = store.archivedLog(meta.id);
    if (archived !== undefined) {
      const exitCode = store.archivedExitCode(meta.id);
      const view = await judgeExecution(archived, verification(meta), exitCode, true);
      return { meta, job: { state: exitCode === undefined ? (view.status === "success" ? "succeeded" : "failed") : exitCode === 0 ? "succeeded" : "failed", reason: view.reason }, view };
    }
    const job = await kube.getJob(jobName(meta.id));
    const pods = job ? await kube.listPods(`${EXECUTION_LABEL}=${meta.id}`) : [];
    const pod = pods[0];
    let text = "";
    let logError: string | undefined;
    if (pod && pod.status?.phase !== "Pending") {
      try {
        text = await kube.podLog(pod.metadata.name, RUNNER_CONTAINER);
      } catch (error) {
        logError = `Runner log unavailable: ${(error as Error).message}`;
      }
    }
    const exitCode = pod?.status?.containerStatuses?.find((c) => c.name === RUNNER_CONTAINER)?.state?.terminated?.exitCode;
    const doneState = jobState(job).state;
    // An unreadable log is not an empty one: it is reported as unreadable, below.
    const view = await judgeExecution(text, verification(meta), exitCode, (doneState === "succeeded" || doneState === "failed") && !logError);
    // A pod that can't start (a missing Secret, an image that can't be pulled) says why only in its events.
    let warning: string | undefined;
    if (pod && pod.status?.phase === "Pending") {
      try {
        warning = (await kube.podWarnings(pod.metadata.name)).at(-1);
      } catch {
        warning = undefined;
      }
    }
    const waiting = pod?.status?.containerStatuses?.find((c) => c.name === RUNNER_CONTAINER)?.state?.waiting;
    const state = jobState(job);
    let reason = state.reason ?? logError ?? (warning && `Pod not started: ${warning}`);
    if (waiting?.reason && waiting.reason !== "ContainerCreating" && waiting.reason !== "PodInitializing") reason = `${waiting.reason}${waiting.message ? `: ${waiting.message}` : ""}`;
    if ((state.state === "succeeded" || state.state === "failed") && text) store.archiveLog(meta.id, text, exitCode);
    const finished = state.state === "failed" || state.state === "succeeded";
    if (finished && (view.status === "pending" || view.status === "running")) {
      view.status = "error";
      view.reason = reason ?? (state.state === "failed" ? "The Job failed before the runner reported a result" : "The Job finished, but the runner's result could not be read");
    } else if (logError && !view.reason) view.reason = logError;
    if (!job && view.status === "pending") {
      view.status = "error";
      view.reason = "The Job no longer exists and no result was archived";
    }
    return { meta, job: { ...state, reason }, view };
  }

  // ---- starting an execution --------------------------------------------------------------------------------------

  const decide = (meta: ExecutionMeta, by: Actor, decision: string, reason: string): ExecutionMeta => ({ ...meta, decisions: [...(meta.decisions ?? []), { at: now().toISOString(), by, decision, reason }] });

  /** Re-derives what the execution would run now; any difference from the approved request invalidates it. */
  async function currentDigest(meta: ExecutionMeta): Promise<{ digest?: string; problem?: string }> {
    const s = await store.checked(meta.snapshotId);
    if (!s) return { problem: "The snapshot no longer exists" };
    if (Date.parse(s.record.expiresAt) <= now().getTime()) return { problem: "The snapshot has expired" };
    if (!s.record.executable) return { problem: "The snapshot is not executable" };
    const resolved = resolveSecret(meta.snapshotId, s.manifest.requirements.secrets.map((x) => x.name));
    if (resolved.problem) return { problem: resolved.problem };
    return { digest: requestDigest({ id: meta.id, snapshotId: meta.snapshotId, workflow: meta.workflow, inputs: meta.inputs, variables: meta.variables, network: meta.network, secret: resolved.secret, initiatedBy: meta.initiatedBy!.id }) };
  }

  /** Runs the cluster checks and creates the Job. The execution's request was validated and authorized before. */
  async function start(meta: ExecutionMeta, by: Actor): Promise<ApiResponse> {
    const s = await store.checked(meta.snapshotId);
    if (!s) return err(404, "No such snapshot");
    const resolved = resolveSecret(meta.snapshotId, s.manifest.requirements.secrets.map((x) => x.name));
    if (resolved.problem) return err(422, "Execution rejected", [resolved.problem]);
    const network = meta.network as NetworkMode;
    // H4: the Job's contents are constrained by the API server, not only by buildJob; refuse until that is proven.
    const admitted = await admission.ensureFresh();
    if (admitted.state !== "enforced") return err(409, "Execution refused: the cluster does not enforce the runner admission policy", [admitted.reason ?? admitted.state]);
    const check = await networkCheck.ensureFresh();
    const verdict = network === "isolated" ? { state: check.state, reason: check.reason } : (check.egress ?? { state: "unverified", reason: "The egress network check has not run" });
    if (verdict.state !== "enforced") {
      return err(409, network === "isolated" ? "Isolated execution refused: network isolation is not proven" : "Egress execution refused: blocking of internal and metadata addresses is not proven", [verdict.reason ?? verdict.state]);
    }
    const integrity = await store.verifyStored(meta.snapshotId, now());
    if (integrity.length) return err(409, "Stored snapshot failed verification", integrity.map((p) => p.message));
    let running = 0;
    for (const other of store.listExecutions().slice(0, 50)) {
      if (stateOf(other) !== "started" || store.archivedLog(other.id) !== undefined) continue;
      const st = jobState(await kube.getJob(jobName(other.id))).state;
      if (st === "running" || st === "pending") running++;
    }
    if (running >= config.maxConcurrent) return err(429, `${running} executions are already running (limit ${config.maxConcurrent})`);

    const secret = resolved.secret ? { name: resolved.secret.name, keys: resolved.secret.keys } : undefined;
    const started: ExecutionMeta = decide({ ...meta, state: "started", startedAt: now().toISOString(), secretName: secret?.name, secretKeys: secret?.keys, isolation: { state: verdict.state, checkedAt: check.checkedAt, reason: verdict.reason }, eventAuth: "ed25519" }, by, "started", meta.approval ? "Approved; cluster checks passed" : "No approval required; cluster checks passed");
    const job = buildJob({
      executionId: meta.id,
      snapshotId: meta.snapshotId,
      snapshotName: meta.snapshotName,
      snapshotVersion: meta.snapshotVersion,
      workflow: meta.workflow,
      inputs: meta.inputs,
      variables: meta.variables,
      secret,
      network,
      namespace: config.namespace,
      runnerImage: config.runnerImage,
      pvcName: config.pvcName,
      snapshotSubPath: store.subPath(meta.snapshotId),
      serviceAccountName: config.runnerServiceAccount,
      executorPodLabels: config.executorPodLabels,
      isolation: config.isolation,
      resources: config.resources,
      maxMinutes: config.maxMinutes,
      maxStepLogBytes: config.maxStepLogBytes,
      maxLogBytes: config.maxLogBytes,
      ttlSecondsAfterFinished: config.ttlSecondsAfterFinished,
    });
    store.saveExecution(started);
    await kube.createJob(job);
    audit.write({ action: "execution-started", execution: meta.id, by, snapshot: meta.snapshotId, workflow: meta.workflow, initiatedBy: meta.initiatedBy, approvedBy: meta.approval?.decidedBy ?? null, secret: secret?.name ?? null, secretKeys: secret?.keys ?? [], network, isolation: verdict.state, inputs: Object.keys(meta.inputs) });
    return json(201, { execution: started });
  }

  // ---- handlers ---------------------------------------------------------------------------------------------------

  const handlers = {
    async listSnapshots(p: Principal) {
      return json(200, { snapshots: (await store.listChecked(now())).filter((r) => snapshotVisible(p, r)) });
    },
    async putSnapshot(p: Principal, r: ApiRequest) {
      const body = parseJson(r) as SnapshotBundle & { visibility?: unknown };
      if (body.visibility !== undefined && body.visibility !== "shared" && body.visibility !== "restricted") return err(422, "Snapshot rejected", ['visibility must be "shared" or "restricted"']);
      const visibility: Visibility = body.visibility ?? "shared";
      const result = await store.put({ manifest: body.manifest, contents: body.contents }, now(), { preparedBy: actor(p), visibility });
      if (!result.record) return err(422, "Snapshot rejected", result.problems);
      // The same content stored before: its record (and preparer) stand; it is shown only to who may see it.
      if (!result.created && !snapshotVisible(p, result.record)) return err(409, "This content is already stored as a restricted snapshot prepared by someone else");
      audit.write({ action: result.created ? "snapshot-stored" : "snapshot-exists", by: actor(p), snapshot: result.record.id, name: result.record.name, version: result.record.version, visibility: result.record.visibility ?? "shared", source: result.record.source });
      return json(result.created ? 201 : 200, { snapshot: result.record, created: result.created });
    },
    async getSnapshot(p: Principal, id: string) {
      const s = await store.checked(id);
      if (!s || !snapshotVisible(p, s.record)) return err(404, "No such snapshot");
      const { binding, problem } = secretBindingFor(id);
      return json(200, { ...s, secretBinding: binding ? { name: binding.name, secret: binding.secret, keys: binding.keys } : null, secretBindingProblem: problem ?? null, allowEgress: config.allowEgress, approvalPolicy: config.approval });
    },
    async verifySnapshot(p: Principal, id: string) {
      const s = store.get(id);
      if (!s || !snapshotVisible(p, s.record)) return err(404, "No such snapshot");
      const problems = await store.verifyStored(id, now());
      return json(200, { ok: problems.length === 0, problems });
    },
    async deleteSnapshot(p: Principal, id: string) {
      const s = store.get(id);
      if (!s || !snapshotVisible(p, s.record)) return err(404, "No such snapshot");
      const own = s.record.preparedBy?.id === p.user.id;
      if (!(own && has(p, "snapshots.delete-own")) && !has(p, "snapshots.delete-any")) return denied(p, "delete-snapshot", own ? "This needs the snapshots.delete-own permission" : "Only its preparer or an administrator can delete a snapshot", 403, { snapshot: id });
      for (const meta of store.listExecutions().filter((m) => m.snapshotId === id)) {
        const st = await status(meta);
        if (st.job.state === "running" || st.job.state === "pending") return err(409, "An execution of this snapshot is still running");
      }
      store.delete(id);
      audit.write({ action: "snapshot-deleted", by: actor(p), snapshot: id });
      return json(200, { deleted: id });
    },
    async listExecutions(p: Principal) {
      const metas = store.listExecutions().filter((m) => executionVisible(p, m)).slice(0, 50);
      const out = [];
      for (const meta of metas) {
        try {
          const s = await status(meta);
          out.push({ meta, job: s.job, status: s.view.status, reason: s.view.reason });
        } catch (error) {
          out.push({ meta, job: { state: "missing" }, status: "error", reason: (error as Error).message });
        }
      }
      return json(200, { executions: out });
    },
    async createExecution(p: Principal, r: ApiRequest) {
      const body = parseJson(r) as Record<string, unknown>;
      const snapshotId = String(body.snapshotId ?? "");
      // H1: executability is the executor's own verdict over the packaged files, never the manifest's claim.
      const s = await store.checked(snapshotId);
      if (!s || !snapshotVisible(p, s.record)) return err(404, "No such snapshot");
      // H2: a restricted snapshot runs only for its preparer.
      if (s.record.visibility === "restricted" && s.record.preparedBy?.id !== p.user.id) return denied(p, "create-execution", "A restricted snapshot can be run only by its preparer", 403, { snapshot: snapshotId });
      const problems: string[] = [];
      if (Date.parse(s.record.expiresAt) <= now().getTime()) problems.push("The snapshot has expired");
      if (!s.record.executable) problems.push("The executor's validation of the packaged files found errors or mismatches, so the snapshot is not executable");
      const workflow = String(body.workflow ?? "");
      if (!s.manifest.entryWorkflows.includes(workflow)) problems.push(`${workflow || "(none)"} is not an entry workflow of this snapshot`);
      const specs = s.manifest.requirements.inputs[workflow] ?? {};
      const inputs = stringRecord(body.inputs, "inputs", problems);
      for (const k of Object.keys(inputs)) if (!(k in specs)) problems.push(`Input ${k} is not declared by ${workflow}`);
      for (const [k, spec] of Object.entries(specs)) if (spec.required && !(k in inputs) && spec.default === undefined) problems.push(`Input ${k} is required`);
      const variables = stringRecord(body.variables, "variables", problems);
      const neededVars = s.manifest.requirements.variables.map((v) => v.name);
      for (const k of Object.keys(variables)) if (!neededVars.includes(k) || !VAR_NAME.test(k)) problems.push(`Variable ${k} is not used by this snapshot`);
      for (const k of neededVars) if (!(k in variables)) problems.push(`Variable ${k} is required`);
      // C1: the Secret and its keys come only from the snapshot's binding.
      if (body.secretName !== undefined && body.secretName !== "") problems.push("secretName can't be chosen: the Secret comes from the snapshot's binding, set by a cluster administrator");
      const resolved = resolveSecret(snapshotId, s.manifest.requirements.secrets.map((x) => x.name));
      if (resolved.problem) problems.push(resolved.problem);
      // C2: isolated by default; egress only where an administrator enabled it. "github-blocked" no longer exists.
      let network: NetworkMode | null = null;
      if (body.network === undefined || body.network === "isolated") network = "isolated";
      else if (body.network === "egress") {
        if (config.allowEgress) network = "egress";
        else problems.push("Egress mode is disabled (chart value network.allowEgressMode)");
      } else if (body.network === "github-blocked") problems.push('"github-blocked" was removed: it blocked only GitHub\'s hostnames and was not isolated. Use "isolated", or "egress" where enabled');
      else problems.push('network must be "isolated" or "egress"');
      if (problems.length) return err(422, "Execution rejected", problems);

      const id = randomBytes(8).toString("hex");
      const visibility = s.record.visibility ?? "shared";
      const trigger = config.approval.requireFor;
      const reasons = [
        ...(trigger.includes("all") ? ["Every execution needs approval (approval.requireFor: all)"] : []),
        ...(trigger.includes("secrets") && resolved.secret ? [`It receives ${resolved.secret.keys.join(", ")} from Secret ${resolved.secret.name} (binding ${resolved.secret.binding})`] : []),
        ...(trigger.includes("egress") && network === "egress" ? ["It runs in egress mode, with network access"] : []),
        ...(trigger.includes("restricted") && visibility === "restricted" ? ["Its snapshot is restricted"] : []),
      ];
      const digest = requestDigest({ id, snapshotId, workflow, inputs, variables, network: network!, secret: resolved.secret, initiatedBy: p.user.id });
      const meta: ExecutionMeta = decide(
        {
          id,
          snapshotId,
          snapshotName: s.record.name,
          snapshotVersion: s.record.version,
          workflow,
          inputs,
          variables,
          network: network!,
          createdAt: now().toISOString(),
          jobName: jobName(id),
          preparedBy: s.record.preparedBy ?? null,
          initiatedBy: actor(p),
          visibility,
          state: reasons.length ? "awaiting-approval" : "approved",
          ...(reasons.length ? { approval: { reasons, requestDigest: digest, expiresAt: new Date(now().getTime() + config.approval.ttlMinutes * 60_000).toISOString() } } : {}),
        },
        actor(p),
        "requested",
        reasons.length ? `Needs approval: ${reasons.join("; ")}` : `No approval required by the policy (${trigger.join(", ") || "none"})`,
      );
      if (reasons.length) {
        store.saveExecution(meta);
        audit.write({ action: "execution-requested", execution: id, by: actor(p), snapshot: snapshotId, workflow, requestDigest: digest, approvalReasons: reasons, inputs: Object.keys(inputs) });
        return json(202, { execution: meta });
      }
      // Not started (a cluster check refused it): nothing is kept, as before H2.
      return start(meta, actor(p));
    },
    async getExecution(p: Principal, id: string) {
      const meta = store.getExecution(id);
      if (!meta || !executionVisible(p, meta)) return err(404, "No such execution");
      return json(200, await status(meta));
    },
    async approveExecution(p: Principal, id: string, r: ApiRequest) {
      const meta = store.getExecution(id);
      if (!meta || !executionVisible(p, meta)) return err(404, "No such execution");
      const forbidden = need(p, "executions.approve", "approve-execution", { execution: id });
      if (forbidden) return forbidden;
      const body = parseJson(r) as { decision?: unknown; requestDigest?: unknown; comment?: unknown };
      if (body.decision !== "approve" && body.decision !== "reject") return err(422, 'decision must be "approve" or "reject"');
      const comment = typeof body.comment === "string" ? body.comment.slice(0, 500) : "";
      if (stateOf(meta) !== "awaiting-approval" || !meta.approval) return err(409, `This execution is ${stateOf(meta)}, not awaiting approval`);
      if (config.approval.separationOfDuties && (meta.initiatedBy?.id === p.user.id || meta.preparedBy?.id === p.user.id)) {
        return denied(p, "approve-execution", "Separation of duties: you can't approve an execution you started or whose snapshot you prepared", 403, { execution: id });
      }
      if (body.requestDigest !== meta.approval.requestDigest) {
        audit.write({ action: "approval-mismatch", execution: id, by: actor(p), presented: typeof body.requestDigest === "string" ? body.requestDigest.slice(0, 64) : null, expected: meta.approval.requestDigest });
        return err(409, "This approval was given for a different request: the digest you reviewed is not this execution's");
      }
      if (Date.parse(meta.approval.expiresAt) <= now().getTime()) {
        store.saveExecution(decide({ ...meta, state: "invalidated" }, actor(p), "invalidated", "The approval request expired"));
        return err(409, "The approval request has expired; the initiator must request the execution again");
      }
      const current = await currentDigest(meta);
      if (current.digest !== meta.approval.requestDigest) {
        const reason = current.problem ?? "What the execution would run changed since it was requested (its Secret binding)";
        store.saveExecution(decide({ ...meta, state: "invalidated" }, actor(p), "invalidated", reason));
        audit.write({ action: "approval-invalidated", execution: id, by: actor(p), reason });
        return err(409, "The approval request is no longer valid", [reason]);
      }
      const approve = body.decision === "approve";
      const decided: ExecutionMeta = decide(
        { ...meta, state: approve ? "approved" : "rejected", approval: { ...meta.approval, decision: approve ? "approved" : "rejected", decidedBy: actor(p), decidedAt: now().toISOString(), comment, expiresAt: new Date(now().getTime() + config.approval.ttlMinutes * 60_000).toISOString() } },
        actor(p),
        approve ? "approved" : "rejected",
        comment || (approve ? "Approved" : "Rejected"),
      );
      store.saveExecution(decided);
      audit.write({ action: approve ? "execution-approved" : "execution-rejected", execution: id, by: actor(p), initiatedBy: meta.initiatedBy, requestDigest: meta.approval.requestDigest, comment });
      if (!approve) return json(200, { execution: decided });
      // Started at once; if a cluster check refuses now, the approval stands and the initiator can start it later.
      const started = await start(decided, actor(p));
      return started.status === 201 ? started : json(200, { execution: decided, startProblem: started.body });
    },
    async startExecution(p: Principal, id: string) {
      const meta = store.getExecution(id);
      if (!meta || !executionVisible(p, meta)) return err(404, "No such execution");
      const forbidden = need(p, "executions.create", "start-execution", { execution: id });
      if (forbidden) return forbidden;
      if (meta.initiatedBy?.id !== p.user.id) return denied(p, "start-execution", "Only the execution's initiator can start it", 403, { execution: id });
      if (stateOf(meta) !== "approved" || !meta.approval?.decidedBy) return err(409, `This execution is ${stateOf(meta)}: only an approved execution can be started`);
      if (Date.parse(meta.approval.expiresAt) <= now().getTime()) {
        store.saveExecution(decide({ ...meta, state: "invalidated" }, actor(p), "invalidated", "The approval expired before the execution started"));
        return err(409, "The approval has expired; request the execution again");
      }
      const current = await currentDigest(meta);
      if (current.digest !== meta.approval.requestDigest) {
        const reason = current.problem ?? "What the execution would run changed since it was approved (its Secret binding)";
        store.saveExecution(decide({ ...meta, state: "invalidated" }, actor(p), "invalidated", reason));
        audit.write({ action: "approval-invalidated", execution: id, by: actor(p), reason });
        return err(409, "The approval is no longer valid", [reason]);
      }
      return start(meta, actor(p));
    },
    async stopExecution(p: Principal, id: string) {
      const meta = store.getExecution(id);
      if (!meta || !executionVisible(p, meta)) return err(404, "No such execution");
      const own = meta.initiatedBy?.id === p.user.id;
      if (!(own && has(p, "executions.cancel-own")) && !has(p, "executions.cancel-any")) return denied(p, "stop-execution", "Only its initiator or an administrator can stop an execution", 403, { execution: id });
      if (stateOf(meta) === "awaiting-approval" || stateOf(meta) === "approved") {
        store.saveExecution(decide({ ...meta, state: "cancelled" }, actor(p), "cancelled", "Cancelled before it started"));
      } else await kube.deleteJob(meta.jobName);
      audit.write({ action: "execution-stopped", execution: id, by: actor(p) });
      return json(200, { stopped: id });
    },

    // ---- administration -----------------------------------------------------------------------------------------

    listUsers() {
      return json(200, { users: users.users().map((u) => ({ ...u, effectiveRoles: users.rolesOf(u), pinnedRoles: users.pinnedRoles(u), sessions: users.sessionsOf(u.id).length })), roles: ROLES });
    },
    setRoles(p: Principal, id: string, r: ApiRequest) {
      if (!USER_ID.test(id) || !users.user(id)) return err(404, "No such user");
      if (id === p.user.id) return denied(p, "set-roles", "You can't change your own roles", 403, { user: id });
      const body = parseJson(r) as { roles?: unknown };
      if (!Array.isArray(body.roles) || !body.roles.every(isRole)) return err(422, `roles must be a list of ${ROLES.join(", ")}`);
      const before = users.user(id)!;
      const updated = users.setRoles(id, body.roles, p.user.id)!;
      audit.write({ action: "roles-changed", by: actor(p), user: { id, name: updated.name }, before: before.roles, after: updated.roles });
      return json(200, { user: { ...updated, effectiveRoles: users.rolesOf(updated), pinnedRoles: users.pinnedRoles(updated) } });
    },
    setDisabled(p: Principal, id: string, disabled: boolean) {
      if (!USER_ID.test(id) || !users.user(id)) return err(404, "No such user");
      if (id === p.user.id) return denied(p, disabled ? "disable-user" : "enable-user", "You can't disable or enable yourself", 403, { user: id });
      const updated = users.setDisabled(id, disabled, p.user.id)!;
      audit.write({ action: disabled ? "user-disabled" : "user-enabled", by: actor(p), user: { id, name: updated.name } });
      return json(200, { user: updated });
    },
    revokeSessions(p: Principal, id: string) {
      if (!USER_ID.test(id) || !users.user(id)) return err(404, "No such user");
      const n = users.revokeUser(id);
      audit.write({ action: "sessions-revoked", by: actor(p), user: { id }, sessions: n });
      return json(200, { revoked: n });
    },
    listBindings() {
      const { bindings, problems } = deps.loadBindings();
      const state = deps.bindingState.all();
      return json(200, { bindings: bindings.map((b) => ({ ...b, suspension: state[b.name] ?? null })), problems });
    },
    setBinding(p: Principal, name: string, r: ApiRequest) {
      const { bindings } = deps.loadBindings();
      if (!bindings.some((b) => b.name === name)) return err(404, "No such binding: bindings are created in the chart's values by a cluster administrator");
      const body = parseJson(r) as { suspended?: unknown; reason?: unknown };
      if (typeof body.suspended !== "boolean") return err(422, "suspended must be true or false");
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      if (reason.length < 5) return err(422, "A reason is required");
      deps.bindingState.set(name, { suspended: body.suspended, by: actor(p), at: now().toISOString(), reason });
      audit.write({ action: body.suspended ? "binding-suspended" : "binding-resumed", by: actor(p), binding: name, reason });
      return json(200, { binding: name, suspended: body.suspended });
    },
  };

  // ---- sign-in ----------------------------------------------------------------------------------------------------

  const principalView = (p: Principal) => ({
    user: { id: p.user.id, name: p.user.name, email: p.user.email, kind: p.user.kind, issuer: p.user.issuer, subject: p.user.subject },
    roles: p.roles,
    permissions: [...permissionsOf(p.roles)].sort(),
    session: { method: p.session.method, createdAt: p.session.createdAt, expiresAt: p.session.expiresAt },
  });
  const sessionCookie = (token: string, expiresAt: string) => setCookie(SESSION_COOKIE, token, { sameSite: "Strict", maxAge: Math.max(0, Math.floor((Date.parse(expiresAt) - now().getTime()) / 1000)) });
  const clearSession = setCookie(SESSION_COOKIE, "", { sameSite: "Strict", maxAge: 0 });

  async function login(r: ApiRequest): Promise<ApiResponse> {
    const provider = deps.auth.provider;
    if (!provider) return err(404, "Single sign-on is not configured on this executor");
    const returnTo = r.query?.get("return") ?? "#/emergency";
    let url: string;
    let binding: string;
    try {
      const begun = await provider.begin();
      url = begun.url;
      binding = users.savePending(begun.pending, RETURN_TO.test(returnTo) ? returnTo : "#/emergency");
    } catch (error) {
      audit.write({ action: "sign-in-failed", stage: "begin", reason: (error as Error).message });
      return redirect(uiUrl("#/emergency/sign-in-failed"));
    }
    return redirect(url, [setCookie(LOGIN_COOKIE, binding, { sameSite: "Lax", maxAge: 600 })]);
  }

  async function callback(r: ApiRequest): Promise<ApiResponse> {
    const provider = deps.auth.provider;
    if (!provider) return err(404, "Single sign-on is not configured on this executor");
    const clearLogin = setCookie(LOGIN_COOKIE, "", { sameSite: "Lax", maxAge: 0 });
    const pending = users.takePending(cookies(r.headers.cookie)[LOGIN_COOKIE]);
    const fail = (reason: string) => {
      audit.write({ action: "sign-in-failed", stage: "callback", reason });
      return redirect(uiUrl("#/emergency/sign-in-failed"), [clearLogin]);
    };
    if (!pending) return fail("No sign-in in progress in this browser (missing, used or expired sign-in cookie)");
    let identity;
    try {
      identity = await provider.complete(r.query ?? new URLSearchParams(), pending.pending);
    } catch (error) {
      return fail((error as Error).message);
    }
    const user = users.signedIn(identity);
    if (user.disabled) return fail(`${user.name} (${user.id}) is disabled`);
    const { token, record } = users.createSession(user, "oidc");
    audit.write({ action: "signed-in", by: { id: user.id, name: user.name }, method: "oidc", issuer: identity.issuer, roles: users.rolesOf(user) });
    return redirect(uiUrl(pending.returnTo), [clearLogin, sessionCookie(token, record.expiresAt)]);
  }

  function breakGlass(r: ApiRequest): ApiResponse {
    if (!deps.auth.breakGlass) return err(404, "Break-glass sign-in is not enabled");
    const body = parseJson(r) as { account?: unknown; credential?: unknown; reason?: unknown };
    const account = typeof body.account === "string" ? body.account : "";
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    if (reason.length < 10) return err(422, "Break-glass sign-in needs a reason (at least 10 characters); it is audited");
    const result = users.breakGlass(account, typeof body.credential === "string" ? body.credential : "");
    if (!result.user) {
      audit.write({ action: "break-glass-failed", account: account.slice(0, 64), reason: result.problem });
      return err(401, result.problem!);
    }
    if (result.user.disabled) return denied(undefined, "break-glass", `${result.user.name} is disabled`, 401);
    const { token, record } = users.createSession(result.user, "break-glass", reason);
    audit.write({ action: "signed-in", by: { id: result.user.id, name: result.user.name }, method: "break-glass", reason, roles: users.rolesOf(result.user), expiresAt: record.expiresAt });
    return json(200, { signedIn: true, expiresAt: record.expiresAt }, { "Set-Cookie": [sessionCookie(token, record.expiresAt)] });
  }

  // ---- routing ----------------------------------------------------------------------------------------------------

  return async function handle(r: ApiRequest): Promise<ApiResponse> {
    const path = r.path.replace(/\/+$/, "");
    const m405 = () => err(405, "Method not allowed");
    try {
      if (path === "health") return r.method === "GET" ? json(200, { available: true, signIn: { oidc: deps.auth.provider ? { label: deps.auth.provider.label } : null, breakGlass: deps.auth.breakGlass } }) : m405();
      if (path === "auth/login") return r.method === "GET" ? login(r) : m405();
      if (path === "auth/callback") return r.method === "GET" ? callback(r) : m405();
      // Every other route is an API call from the page: it must say so (CSRF), and carry no bearer token.
      if (r.headers[CSRF_HEADER] !== "1") return err(403, `Missing the ${CSRF_HEADER} header`);
      if (r.headers.authorization) return err(401, "The shared operator token no longer authorizes API calls (security review H2): sign in, or use a break-glass account");
      const size = r.body?.length ?? 0;
      if (size > (path === "snapshots" && r.method === "POST" ? MAX_SNAPSHOT_BODY : MAX_SMALL_BODY)) return err(413, "Request body too large");
      if (path === "auth/break-glass") return r.method === "POST" ? breakGlass(r) : m405();

      const p = users.principal(cookies(r.headers.cookie)[SESSION_COOKIE]);
      if (!p) return denied(undefined, `${r.method} ${path.split("/").slice(0, 2).join("/")}`, "No valid session (none, expired, revoked, or the user is disabled)", 401);
      if (path === "auth/session") return r.method === "GET" ? json(200, principalView(p)) : m405();
      if (path === "auth/logout") {
        if (r.method !== "POST") return m405();
        users.revokeSession(p.sessionHash);
        audit.write({ action: "signed-out", by: actor(p) });
        return json(200, { signedOut: true }, { "Set-Cookie": [clearSession] });
      }

      const perm = (perm: Permission, action: string, f: () => ApiResponse | Promise<ApiResponse>) => need(p, perm, action) ?? f();
      let m: RegExpExecArray | null;
      if (path === "snapshots") return r.method === "GET" ? perm("snapshots.read", "list-snapshots", () => handlers.listSnapshots(p)) : r.method === "POST" ? perm("snapshots.create", "upload-snapshot", () => handlers.putSnapshot(p, r)) : m405();
      if ((m = /^snapshots\/([0-9a-f]{64})$/.exec(path))) {
        const id = m[1]!;
        return r.method === "GET" ? perm("snapshots.read", "read-snapshot", () => handlers.getSnapshot(p, id)) : r.method === "DELETE" ? perm("snapshots.read", "delete-snapshot", () => handlers.deleteSnapshot(p, id)) : m405();
      }
      if ((m = /^snapshots\/([0-9a-f]{64})\/verify$/.exec(path))) {
        const id = m[1]!;
        return r.method === "POST" ? perm("snapshots.verify", "verify-snapshot", () => handlers.verifySnapshot(p, id)) : m405();
      }
      if (path === "executions") return r.method === "GET" ? perm("executions.read", "list-executions", () => handlers.listExecutions(p)) : r.method === "POST" ? perm("executions.create", "create-execution", () => handlers.createExecution(p, r)) : m405();
      if ((m = /^executions\/([0-9a-f]{16})$/.exec(path))) {
        const id = m[1]!;
        return r.method === "GET" ? perm("executions.read", "read-execution", () => handlers.getExecution(p, id)) : r.method === "DELETE" ? perm("executions.read", "stop-execution", () => handlers.stopExecution(p, id)) : m405();
      }
      if ((m = /^executions\/([0-9a-f]{16})\/(approve|start)$/.exec(path))) {
        const [id, op] = [m[1]!, m[2]!];
        if (r.method !== "POST") return m405();
        return op === "approve" ? perm("executions.read", "approve-execution", () => handlers.approveExecution(p, id, r)) : perm("executions.read", "start-execution", () => handlers.startExecution(p, id));
      }
      if (path === "admission-check") return r.method === "GET" ? perm("checks.read", "read-admission-check", () => json(200, admission.status())) : r.method === "POST" ? perm("checks.run", "run-admission-check", async () => json(200, await admission.run())) : m405();
      if (path === "network-check") return r.method === "GET" ? perm("checks.read", "read-network-check", () => json(200, networkView())) : r.method === "POST" ? perm("checks.run", "run-network-check", async () => (await networkCheck.run(), json(200, networkView()))) : m405();
      if (path === "admin/users") return r.method === "GET" ? perm("admin.users", "list-users", () => handlers.listUsers()) : m405();
      if ((m = /^admin\/users\/([^/]+)\/(roles|disable|enable|revoke-sessions)$/.exec(path))) {
        const [id, op] = [m[1]!, m[2]!];
        if (op === "roles") return r.method === "PUT" ? perm("admin.users", "set-roles", () => handlers.setRoles(p, id, r)) : m405();
        if (r.method !== "POST") return m405();
        if (op === "revoke-sessions") return perm("admin.sessions", "revoke-sessions", () => handlers.revokeSessions(p, id));
        return perm("admin.users", `${op}-user`, () => handlers.setDisabled(p, id, op === "disable"));
      }
      if (path === "admin/bindings") return r.method === "GET" ? perm("admin.bindings", "list-bindings", () => handlers.listBindings()) : m405();
      if ((m = /^admin\/bindings\/([^/]+)$/.exec(path))) {
        const name = decodeURIComponent(m[1]!);
        if (r.method === "PUT") return perm("admin.bindings", "set-binding", () => handlers.setBinding(p, name, r));
        if (r.method === "POST" || r.method === "DELETE") return perm("admin.bindings", "change-binding", () => err(405, "Bindings are created and changed in the chart's values by a cluster administrator; the API can only suspend or resume them"));
        return m405();
      }
      if (path === "admin/audit") return r.method === "GET" ? perm("admin.audit", "read-audit", () => json(200, { entries: audit.recent(Math.min(1000, Number(r.query?.get("limit") ?? 200) || 200)) })) : m405();
      return err(404, "Not found");
    } catch (error) {
      if (error instanceof RequestError) return err(error.status, error.message);
      audit.write({ action: "error", path, message: (error as Error).message });
      return err(502, (error as Error).message);
    }
  };
}

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function stringRecord(v: unknown, what: string, problems: string[]): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    problems.push(`${what} must be an object of strings`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string" || x.length > 4096 || k.length > 100) problems.push(`${what}.${k} must be a string of at most 4096 characters`);
    else out[k] = x;
  }
  return out;
}

function jobState(job: K8sJob | undefined): { state: ExecutionStatus["job"]["state"]; reason?: string } {
  if (!job) return { state: "missing" };
  const failed = job.status?.conditions?.find((c) => c.type === "Failed" && c.status === "True");
  if (failed) return { state: "failed", reason: [failed.reason, failed.message].filter(Boolean).join(": ") };
  if (job.status?.conditions?.some((c) => c.type === "Complete" && c.status === "True") || job.status?.succeeded) return { state: "succeeded" };
  if (job.status?.failed) return { state: "failed" };
  return { state: job.status?.active ? "running" : "pending" };
}
