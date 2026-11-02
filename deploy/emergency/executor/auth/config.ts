// The executor's sign-in, session and approval configuration (security review H2), rendered by the chart into a
// ConfigMap (charts/gha-emergency/templates/auth.yaml) and read once at startup. Invalid configuration stops the
// executor rather than weakening anything: unknown roles, a non-HTTPS issuer (unless explicitly allowed for local
// development), an approval policy that names nothing known.
import type { ApprovalPolicy, ApprovalTrigger } from "../api.ts";
import { isRole, type Role } from "./roles.ts";

export type AuthConfig = {
  oidc: { issuer: string; clientId: string; redirectUri: string; scopes?: string[]; algorithms?: string[]; label?: string; clientSecretFile?: string; allowInsecureHttp?: boolean } | null;
  sessions: { maxHours: number; idleMinutes: number; breakGlassMinutes: number };
  initialAdministrators: { issuer: string; subject: string }[];
  breakGlass: { accounts: { name: string; roles: Role[] }[]; credentialsDir: string };
  approval: ApprovalPolicy;
};

const TRIGGERS: ApprovalTrigger[] = ["secrets", "egress", "restricted", "all"];
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseAuthConfig(text: string): AuthConfig {
  const raw = JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- validated field by field below
  const fail = (m: string): never => {
    throw new Error(`Invalid sign-in configuration: ${m}`);
  };
  const num = (v: unknown, d: number, min: number, max: number, what: string) => {
    const n = v === undefined || v === null ? d : Number(v);
    if (!Number.isFinite(n) || n < min || n > max) fail(`${what} must be between ${min} and ${max}`);
    return n;
  };
  let oidc: AuthConfig["oidc"] = null;
  if (raw.oidc && raw.oidc.issuer) {
    const o = raw.oidc;
    for (const k of ["issuer", "clientId", "redirectUri"]) if (typeof o[k] !== "string" || !o[k]) fail(`oidc.${k} is required`);
    const insecure = o.allowInsecureHttp === true;
    for (const k of ["issuer", "redirectUri"]) {
      let u: URL;
      try {
        u = new URL(o[k]);
      } catch {
        return fail(`oidc.${k} is not a URL`);
      }
      if (u.protocol !== "https:" && !(insecure && u.protocol === "http:")) fail(`oidc.${k} must be HTTPS`);
    }
    if (!/\/api\/emergency\/auth\/callback$/.test(new URL(o.redirectUri).pathname)) fail("oidc.redirectUri must end with api/emergency/auth/callback");
    oidc = { issuer: o.issuer, clientId: o.clientId, redirectUri: o.redirectUri, scopes: o.scopes, algorithms: o.algorithms, label: o.label || undefined, clientSecretFile: o.clientSecretFile || undefined, allowInsecureHttp: insecure };
    if (oidc.scopes && !oidc.scopes.includes("openid")) fail('oidc.scopes must include "openid"');
  }
  const admins = (raw.initialAdministrators ?? []) as { issuer?: unknown; subject?: unknown }[];
  if (!Array.isArray(admins) || admins.some((a) => typeof a?.issuer !== "string" || typeof a?.subject !== "string" || !a.subject)) fail("initialAdministrators entries need issuer and subject");
  const accounts = (raw.breakGlass?.accounts ?? []) as { name?: unknown; roles?: unknown }[];
  if (!Array.isArray(accounts)) fail("breakGlass.accounts must be a list");
  for (const a of accounts) {
    if (typeof a.name !== "string" || !ACCOUNT.test(a.name)) fail(`break-glass account name ${JSON.stringify(a.name)} is not a lowercase name`);
    if (!Array.isArray(a.roles) || !a.roles.every(isRole)) fail(`break-glass account ${String(a.name)} needs roles from viewer, operator, approver, administrator`);
    if ((a.roles as Role[]).includes("administrator")) fail(`break-glass account ${String(a.name)} can't be an administrator: roles are managed by signed-in administrators`);
  }
  if (new Set(accounts.map((a) => a.name)).size !== accounts.length) fail("break-glass account names must be unique");
  const ap = raw.approval ?? {};
  const requireFor = (ap.requireFor ?? ["secrets", "egress"]) as ApprovalTrigger[];
  if (!Array.isArray(requireFor) || !requireFor.every((t) => TRIGGERS.includes(t))) fail(`approval.requireFor must list ${TRIGGERS.join(", ")}`);
  return {
    oidc,
    sessions: { maxHours: num(raw.sessions?.maxHours, 8, 1, 24 * 7, "sessions.maxHours"), idleMinutes: num(raw.sessions?.idleMinutes, 60, 5, 24 * 60, "sessions.idleMinutes"), breakGlassMinutes: num(raw.breakGlass?.sessionMinutes, 60, 5, 240, "breakGlass.sessionMinutes") },
    initialAdministrators: admins as { issuer: string; subject: string }[],
    breakGlass: { accounts: accounts as { name: string; roles: Role[] }[], credentialsDir: String(raw.breakGlass?.credentialsDir ?? "/etc/gha-emergency") },
    approval: { requireFor, separationOfDuties: ap.separationOfDuties !== false, ttlMinutes: num(ap.ttlMinutes, 60, 5, 7 * 24 * 60, "approval.ttlMinutes") },
  };
}
