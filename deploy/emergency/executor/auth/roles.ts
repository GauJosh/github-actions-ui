// Roles and permissions (security review H2). Roles are additive; each grants exactly the permissions listed here, and
// every API operation names the permission it needs (api.ts). Roles come only from the executor's records and its
// configuration (auth/store.ts), never from the identity provider's token or the browser.
export const ROLES = ["viewer", "operator", "approver", "administrator"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "snapshots.read",
  "executions.read",
  "checks.read",
  "snapshots.create",
  "snapshots.verify",
  "snapshots.delete-own",
  "snapshots.delete-any",
  "executions.create",
  "executions.cancel-own",
  "executions.cancel-any",
  "executions.approve",
  "checks.run",
  "admin.users",
  "admin.sessions",
  "admin.bindings",
  "admin.audit",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEW: Permission[] = ["snapshots.read", "executions.read", "checks.read"];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  /** Sees shared snapshots and executions, their status and logs, and the cluster checks. */
  viewer: VIEW,
  /** Prepares snapshots and starts executions; stops and deletes its own. */
  operator: [...VIEW, "snapshots.create", "snapshots.verify", "snapshots.delete-own", "executions.create", "executions.cancel-own", "checks.run"],
  /** Approves or rejects executions that need it (never their own, under separation of duties); sees restricted ones. */
  approver: [...VIEW, "executions.approve"],
  /** Manages other users' roles and sessions, suspends Secret bindings, reads the audit log; stops anything. */
  administrator: [...VIEW, "admin.users", "admin.sessions", "admin.bindings", "admin.audit", "snapshots.delete-any", "executions.cancel-any"],
};

export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

export function permissionsOf(roles: readonly Role[]): Set<Permission> {
  return new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r]));
}
