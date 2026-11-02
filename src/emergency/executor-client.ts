// The browser's client for the emergency executor API (deploy/emergency/executor/api.ts), at "api/emergency/"
// relative to the page, i.e. the same origin and path prefix the UI is served from. The GitHub token is never sent
// here: snapshot preparation reads GitHub in the browser and uploads only the packaged files.
//
// Security review H2: the user signs in with the organization's identity provider through the executor (a full-page
// redirect to auth/login), or with a break-glass account. The session is an HttpOnly cookie this code can't read; it
// is sent only to this same-origin API, with the X-GHA-Emergency header the executor requires of every API call. Roles
// and permissions shown here come from the executor and only shape the UI: the executor checks every request.
import type { ExecutionView } from "./events.ts";
import type { Diagnostic } from "./model.ts";
import type { Actor, Manifest, SnapshotBundle, SnapshotRecord, Visibility } from "./snapshot.ts";

export type ExecutionMeta = {
  id: string;
  snapshotId: string;
  snapshotName: string;
  snapshotVersion: number;
  workflow: string;
  inputs: Record<string, string>;
  variables: Record<string, string>;
  /** The Secret its snapshot's binding names, and the only keys mounted. */
  secretName?: string;
  secretKeys?: string[];
  /** "github-blocked" only in records made before the security review's C2 remediation. */
  network: "isolated" | "egress" | "github-blocked";
  isolation?: { state: string; checkedAt?: string; reason?: string };
  createdAt: string;
  jobName: string;
  /** Security review H2: absent on executions from before it. */
  preparedBy?: Actor | null;
  initiatedBy?: Actor;
  visibility?: Visibility;
  state?: "awaiting-approval" | "approved" | "rejected" | "cancelled" | "invalidated" | "started";
  approval?: { reasons: string[]; requestDigest: string; expiresAt: string; decidedBy?: Actor; decidedAt?: string; decision?: "approved" | "rejected"; comment?: string };
  decisions?: { at: string; by: Actor; decision: string; reason: string }[];
};
export type Role = "viewer" | "operator" | "approver" | "administrator";
export type SessionView = {
  user: { id: string; name: string; email?: string; kind: "oidc" | "break-glass"; issuer?: string; subject?: string };
  roles: Role[];
  permissions: string[];
  session: { method: "oidc" | "break-glass"; createdAt: string; expiresAt: string };
};
export type SignInOptions = { oidc: { label: string } | null; breakGlass: boolean };
export type UserView = { id: string; kind: string; name: string; email?: string; issuer?: string; subject?: string; account?: string; roles: Role[]; effectiveRoles: Role[]; pinnedRoles: Role[]; disabled?: boolean; lastSeen: string; sessions: number };
export type BindingView = { name: string; secret: string; keys: string[]; snapshots: string[]; suspension: { suspended: boolean; by: Actor; at: string; reason: string } | null };
export type AuditEntryView = { at: string; action: string; by?: Actor | null; [k: string]: unknown };
export type NetworkMode = "isolated" | "egress";
export type ProbeResult = { name: string; host: string; port: number; reachable: boolean; detail: string };
export type NetworkCheckView = {
  state: "enforced" | "not-enforced" | "unverified" | "never" | "checking";
  checkedAt?: string;
  reason?: string;
  isolated: ProbeResult[];
  control: ProbeResult[];
  egress?: { state: string; reason?: string; results: ProbeResult[] };
  allowEgress: boolean;
};
export type SecretBindingView = { name: string; secret: string; keys: string[] };
export type JobState = { state: "pending" | "running" | "succeeded" | "failed" | "missing"; reason?: string };
export type ExecutionDetail = { meta: ExecutionMeta; job: JobState; view: ExecutionView };
export type ExecutionSummary = { meta: ExecutionMeta; job: JobState; status: ExecutionView["status"]; reason?: string };

export class ExecutorError extends Error {
  readonly status: number;
  readonly details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const base = () => new URL("api/emergency/", document.baseURI).toString();

/** Where the sign-in button goes: the executor redirects to the identity provider and back to this page. */
export const signInUrl = (returnTo: string) => `${base()}auth/login?${new URLSearchParams({ return: returnTo })}`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", "X-GHA-Emergency": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(base() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ExecutorError(0, "The emergency executor could not be reached");
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const d = data as { error?: string; details?: unknown } | null;
    throw new ExecutorError(response.status, d?.error ?? `Executor returned ${response.status}`, d?.details);
  }
  return data as T;
}

export const executor = {
  /** Whether this deployment has an executor, and how to sign in to it (no session needed). */
  async available(): Promise<SignInOptions | null> {
    try {
      const r = await fetch(base() + "health", { cache: "no-store", credentials: "omit" });
      if (!r.ok) return null;
      const h = (await r.json()) as { available?: boolean; signIn?: SignInOptions };
      return h.available === true ? (h.signIn ?? { oidc: null, breakGlass: false }) : null;
    } catch {
      return null;
    }
  },
  /** The signed-in user, or null when there is no valid session. */
  async session(): Promise<SessionView | null> {
    try {
      return await call<SessionView>("GET", "auth/session");
    } catch (e) {
      if (e instanceof ExecutorError && e.status === 401) return null;
      throw e;
    }
  },
  signOut: () => call<{ signedOut: boolean }>("POST", "auth/logout", {}),
  breakGlass: (account: string, credential: string, reason: string) => call<{ signedIn: boolean; expiresAt: string }>("POST", "auth/break-glass", { account, credential, reason }),
  listSnapshots: () => call<{ snapshots: SnapshotRecord[] }>("GET", "snapshots").then((r) => r.snapshots),
  uploadSnapshot: (bundle: SnapshotBundle, visibility: Visibility = "shared") => call<{ snapshot: SnapshotRecord; created: boolean }>("POST", "snapshots", { ...bundle, visibility }),
  getSnapshot: (id: string) =>
    call<{ record: SnapshotRecord; manifest: Manifest; secretBinding: SecretBindingView | null; secretBindingProblem: string | null; allowEgress: boolean; approvalPolicy?: { requireFor: string[]; separationOfDuties: boolean; ttlMinutes: number } }>("GET", `snapshots/${id}`),
  getNetworkCheck: () => call<NetworkCheckView>("GET", "network-check"),
  runNetworkCheck: () => call<NetworkCheckView>("POST", "network-check", {}),
  verifySnapshot: (id: string) => call<{ ok: boolean; problems: Diagnostic[] }>("POST", `snapshots/${id}/verify`, {}),
  deleteSnapshot: (id: string) => call<{ deleted: string }>("DELETE", `snapshots/${id}`),
  listExecutions: () => call<{ executions: ExecutionSummary[] }>("GET", "executions").then((r) => r.executions),
  startExecution: (request: { snapshotId: string; workflow: string; inputs: Record<string, string>; variables: Record<string, string>; network: NetworkMode }) =>
    call<{ execution: ExecutionMeta }>("POST", "executions", request).then((r) => r.execution),
  getExecution: (id: string) => call<ExecutionDetail>("GET", `executions/${id}`),
  stopExecution: (id: string) => call<{ stopped: string }>("DELETE", `executions/${id}`),
  decide: (id: string, decision: "approve" | "reject", requestDigest: string, comment: string) =>
    call<{ execution: ExecutionMeta; startProblem?: { error: string; details?: unknown } }>("POST", `executions/${id}/approve`, { decision, requestDigest, comment }),
  startApproved: (id: string) => call<{ execution: ExecutionMeta }>("POST", `executions/${id}/start`, {}),
  // Administration (administrators only; the executor refuses everyone else).
  listUsers: () => call<{ users: UserView[]; roles: Role[] }>("GET", "admin/users"),
  setRoles: (id: string, roles: Role[]) => call<{ user: UserView }>("PUT", `admin/users/${id}/roles`, { roles }),
  setDisabled: (id: string, disabled: boolean) => call<{ user: UserView }>("POST", `admin/users/${id}/${disabled ? "disable" : "enable"}`, {}),
  revokeSessions: (id: string) => call<{ revoked: number }>("POST", `admin/users/${id}/revoke-sessions`, {}),
  listBindings: () => call<{ bindings: BindingView[]; problems: string[] }>("GET", "admin/bindings"),
  setBindingSuspended: (name: string, suspended: boolean, reason: string) => call<{ binding: string; suspended: boolean }>("PUT", `admin/bindings/${encodeURIComponent(name)}`, { suspended, reason }),
  audit: () => call<{ entries: AuditEntryView[] }>("GET", "admin/audit").then((r) => r.entries),
};
