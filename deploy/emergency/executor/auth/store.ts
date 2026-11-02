// Users, roles and sessions (security review H2), on the executor's volume under <data>/auth/ (runner pods mount only
// a snapshot's directory, never this):
//
//   users.json                 every identity that has signed in: (issuer, subject) or a break-glass account, its
//                              roles as assigned by administrators, disabled or not
//   sessions/<sha256>.json     one per session, named by the hash of its token (the token itself is never stored)
//
// Roles are the union of the stored assignment and the configuration's pinned roles (initial administrators,
// break-glass accounts), which the API can't change. A disabled user has no roles and no sessions. Sessions expire
// (absolute and idle limits) and can be revoked; they are checked on every request, so a role change or revocation
// takes effect at once. Pending sign-ins are kept in memory for ten minutes and used once.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingLogin, VerifiedIdentity } from "./oidc.ts";
import { isRole, type Role } from "./roles.ts";

export type UserRecord = {
  id: string;
  kind: "oidc" | "break-glass";
  issuer?: string;
  subject?: string;
  account?: string;
  name: string;
  email?: string;
  /** Assigned by administrators through the API. */
  roles: Role[];
  disabled?: boolean;
  firstSeen: string;
  lastSeen: string;
  changedBy?: string;
  changedAt?: string;
};
export type SessionRecord = { userId: string; method: "oidc" | "break-glass"; createdAt: string; expiresAt: string; lastUsed: string; reason?: string };
export type Principal = { user: UserRecord; roles: Role[]; session: SessionRecord; sessionHash: string };

export type AuthStoreConfig = {
  sessionMaxHours: number;
  sessionIdleMinutes: number;
  breakGlassSessionMinutes: number;
  /** Pinned administrators, by issuer and subject (the first administrators of a new installation). */
  initialAdministrators: { issuer: string; subject: string }[];
  /** Break-glass accounts: each has its own credential (a key of a Kubernetes Secret) and pinned roles. */
  breakGlassAccounts: { name: string; roles: Role[] }[];
  /** Reads an account's credential (the mounted Secret's file); undefined when it has none. */
  breakGlassCredential: (account: string) => string | undefined;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const oidcUserId = (issuer: string, subject: string) => `u-${sha(`${issuer}\n${subject}`).slice(0, 24)}`;
export const breakGlassUserId = (account: string) => `bg-${account}`;
export const USER_ID = /^(u-[0-9a-f]{24}|bg-[a-z0-9][a-z0-9-]{0,62})$/;
const BREAK_GLASS_LOCKOUT = { failures: 5, windowMs: 15 * 60_000 };

export function createAuthStore(dataDir: string, config: AuthStoreConfig, now: () => Date = () => new Date()) {
  const dir = join(dataDir, "auth");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const usersFile = join(dir, "users.json");
  const pendingLogins = new Map<string, { pending: PendingLogin; returnTo: string; at: number }>();
  const failures = new Map<string, number[]>();

  const write = (file: string, value: unknown) => {
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  };
  const readUsers = (): Record<string, UserRecord> => (existsSync(usersFile) ? (JSON.parse(readFileSync(usersFile, "utf8")) as Record<string, UserRecord>) : {});
  const saveUser = (u: UserRecord) => write(usersFile, { ...readUsers(), [u.id]: u });

  function pinnedRoles(u: UserRecord): Role[] {
    if (u.kind === "break-glass") return config.breakGlassAccounts.find((a) => a.name === u.account)?.roles ?? [];
    return config.initialAdministrators.some((a) => a.issuer === u.issuer && a.subject === u.subject) ? ["administrator"] : [];
  }
  const rolesOf = (u: UserRecord): Role[] => (u.disabled ? [] : [...new Set([...pinnedRoles(u), ...u.roles.filter(isRole)])]);

  function sessionFiles(): { hash: string; record: SessionRecord }[] {
    return readdirSync(sessionsDir)
      .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
      .map((f) => ({ hash: f.slice(0, 64), record: JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as SessionRecord }));
  }
  const removeSession = (hash: string) => rmSync(join(sessionsDir, `${hash}.json`), { force: true });

  return {
    pinnedRoles,
    rolesOf,
    user: (id: string): UserRecord | undefined => (USER_ID.test(id) ? readUsers()[id] : undefined),
    users: (): UserRecord[] => Object.values(readUsers()).sort((a, b) => a.name.localeCompare(b.name)),

    /** Records a verified identity's sign-in. Nothing from the token but its identity and display name is kept. */
    signedIn(identity: VerifiedIdentity): UserRecord {
      const id = oidcUserId(identity.issuer, identity.subject);
      const at = now().toISOString();
      const existing = readUsers()[id];
      const u: UserRecord = existing ? { ...existing, name: identity.name, email: identity.email, lastSeen: at } : { id, kind: "oidc", issuer: identity.issuer, subject: identity.subject, name: identity.name, email: identity.email, roles: [], firstSeen: at, lastSeen: at };
      saveUser(u);
      return u;
    },

    /** Checks a break-glass credential; repeated failures lock the account out for a while. */
    breakGlass(account: string, credential: string): { user?: UserRecord; problem?: string } {
      const cfg = config.breakGlassAccounts.find((a) => a.name === account);
      const t = now().getTime();
      const recent = (failures.get(account) ?? []).filter((x) => t - x < BREAK_GLASS_LOCKOUT.windowMs);
      if (recent.length >= BREAK_GLASS_LOCKOUT.failures) return { problem: "Too many failed attempts for this break-glass account; try again later" };
      const expected = cfg ? config.breakGlassCredential(account) : undefined;
      const a = Buffer.from(sha(credential), "hex");
      const ok = expected !== undefined && expected.length >= 32 && timingSafeEqual(a, Buffer.from(sha(expected), "hex"));
      if (!ok) {
        failures.set(account, [...recent, t]);
        return { problem: "Unknown break-glass account or wrong credential" };
      }
      failures.delete(account);
      const id = breakGlassUserId(account);
      const at = now().toISOString();
      const existing = readUsers()[id];
      const u: UserRecord = existing ? { ...existing, lastSeen: at } : { id, kind: "break-glass", account, name: `break-glass: ${account}`, roles: [], firstSeen: at, lastSeen: at };
      saveUser(u);
      return { user: u };
    },

    setRoles(id: string, roles: Role[], by: string): UserRecord | undefined {
      const u = readUsers()[id];
      if (!u) return undefined;
      const updated = { ...u, roles: [...new Set(roles)], changedBy: by, changedAt: now().toISOString() };
      saveUser(updated);
      return updated;
    },
    setDisabled(id: string, disabled: boolean, by: string): UserRecord | undefined {
      const u = readUsers()[id];
      if (!u) return undefined;
      const updated = { ...u, disabled, changedBy: by, changedAt: now().toISOString() };
      saveUser(updated);
      if (disabled) this.revokeUser(id);
      return updated;
    },

    /** A new session; the token goes to the browser in an HttpOnly cookie and only its hash is kept. */
    createSession(user: UserRecord, method: SessionRecord["method"], reason?: string): { token: string; record: SessionRecord } {
      const token = randomBytes(32).toString("base64url");
      const t = now();
      const minutes = method === "break-glass" ? config.breakGlassSessionMinutes : config.sessionMaxHours * 60;
      const record: SessionRecord = { userId: user.id, method, createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + minutes * 60_000).toISOString(), lastUsed: t.toISOString(), ...(reason ? { reason } : {}) };
      write(join(sessionsDir, `${sha(token)}.json`), record);
      return { token, record };
    },

    /** The principal behind a session token, or undefined when it is unknown, expired, idle too long or revoked. */
    principal(token: string | undefined): Principal | undefined {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      const hash = sha(token);
      const f = join(sessionsDir, `${hash}.json`);
      if (!existsSync(f)) return undefined;
      const record = JSON.parse(readFileSync(f, "utf8")) as SessionRecord;
      const t = now().getTime();
      const user = readUsers()[record.userId];
      if (!user || user.disabled || Date.parse(record.expiresAt) <= t || t - Date.parse(record.lastUsed) > config.sessionIdleMinutes * 60_000) {
        removeSession(hash);
        return undefined;
      }
      // Idle tracking, written at most once a minute.
      if (t - Date.parse(record.lastUsed) > 60_000) write(f, { ...record, lastUsed: new Date(t).toISOString() });
      return { user, roles: rolesOf(user), session: record, sessionHash: hash };
    },
    revokeSession: (hash: string) => removeSession(hash),
    /** Ends every session of a user; returns how many there were. */
    revokeUser(id: string): number {
      const mine = sessionFiles().filter((s) => s.record.userId === id);
      for (const s of mine) removeSession(s.hash);
      return mine.length;
    },
    sessionsOf: (id: string) => sessionFiles().filter((s) => s.record.userId === id).map((s) => s.record),
    purgeExpiredSessions(): number {
      const t = now().getTime();
      const old = sessionFiles().filter((s) => Date.parse(s.record.expiresAt) <= t || t - Date.parse(s.record.lastUsed) > config.sessionIdleMinutes * 60_000);
      for (const s of old) removeSession(s.hash);
      return old.length;
    },

    /** Keeps a pending sign-in; the returned value goes to the browser as a short-lived cookie that binds it. */
    savePending(pending: PendingLogin, returnTo: string): string {
      const t = now().getTime();
      for (const [k, v] of pendingLogins) if (t - v.at > 600_000) pendingLogins.delete(k);
      if (pendingLogins.size > 1000) pendingLogins.delete(pendingLogins.keys().next().value!);
      const binding = randomBytes(32).toString("base64url");
      pendingLogins.set(sha(binding), { pending, returnTo, at: t });
      return binding;
    },
    takePending(binding: string | undefined): { pending: PendingLogin; returnTo: string } | undefined {
      if (!binding) return undefined;
      const key = sha(binding);
      const p = pendingLogins.get(key);
      pendingLogins.delete(key);
      return p && now().getTime() - p.at <= 600_000 ? { pending: p.pending, returnTo: p.returnTo } : undefined;
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
