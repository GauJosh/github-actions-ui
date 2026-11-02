// Secret bindings (security review C1): which Kubernetes Secret, and which of its keys, an execution of a given
// snapshot may receive. Bindings are written by a cluster administrator in the chart's values (rendered into a
// ConfigMap the executor reads), not chosen by whoever starts an execution.
//
// - A binding names exact snapshot digests. Names and claimed source repositories are client-asserted (review H1),
//   so they can't authorize anything; a digest pins the reviewed content.
// - An execution mounts only the keys its snapshot requires, and only from its binding's Secret.
// - The operator-token Secret can never be bound.
// The file is read for every execution, so ConfigMap updates apply without a restart. Problems fail closed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SecretBinding = { name: string; secret: string; keys: string[]; snapshots: string[] };

const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function parseBindings(text: string, operatorSecret: string): { bindings: SecretBinding[]; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { bindings: [], problems: ["Secret bindings are not valid JSON"] };
  }
  if (!Array.isArray(raw)) return { bindings: [], problems: ["Secret bindings must be a list"] };
  const bindings: SecretBinding[] = [];
  raw.forEach((b: unknown, i) => {
    const r = (b ?? {}) as Record<string, unknown>;
    const where = `binding ${i + 1}${typeof r.name === "string" ? ` (${r.name})` : ""}`;
    const before = problems.length;
    if (typeof r.name !== "string" || !r.name.trim()) problems.push(`${where}: name is required`);
    if (typeof r.secret !== "string" || !K8S_NAME.test(r.secret) || r.secret.length > 253) problems.push(`${where}: secret must be a Kubernetes object name`);
    else if (r.secret === operatorSecret) problems.push(`${where}: the operator-token Secret can never be bound`);
    if (!Array.isArray(r.keys) || r.keys.length === 0 || !r.keys.every((k) => typeof k === "string" && SECRET_KEY.test(k))) problems.push(`${where}: keys must be a non-empty list of secret names`);
    else if (new Set(r.keys).size !== r.keys.length) problems.push(`${where}: keys must be unique`);
    if (!Array.isArray(r.snapshots) || r.snapshots.length === 0 || !r.snapshots.every((d) => typeof d === "string" && DIGEST.test(d))) problems.push(`${where}: snapshots must be a non-empty list of snapshot digests (64 hex characters)`);
    if (problems.length === before) bindings.push({ name: String(r.name), secret: String(r.secret), keys: r.keys as string[], snapshots: r.snapshots as string[] });
  });
  return { bindings, problems };
}

/** Reads the bindings file. A missing file means no bindings; an invalid file binds nothing (fail closed). */
export function loadBindingsFile(path: string, operatorSecret: string): { bindings: SecretBinding[]; problems: string[] } {
  if (!existsSync(path)) return { bindings: [], problems: [] };
  return parseBindings(readFileSync(path, "utf8"), operatorSecret);
}

/** The single binding for a snapshot digest; more than one is ambiguous and refused. */
export function bindingFor(bindings: SecretBinding[], snapshotId: string): { binding?: SecretBinding; problem?: string } {
  const matches = bindings.filter((b) => b.snapshots.includes(snapshotId));
  if (matches.length > 1) return { problem: `More than one Secret binding names this snapshot (${matches.map((b) => b.name).join(", ")})` };
  return { binding: matches[0] };
}

// ---- suspension (security review H2) -------------------------------------------------------------------------------
// Bindings themselves are cluster configuration (the chart's values, which the admission policy also renders, H4), so
// the API can't create or widen one. An administrator can suspend a binding (and resume it): a suspended binding gives
// no execution its Secret, and approvals that relied on it are invalidated. Kept in <data>/auth/bindings.json.
export type BindingSuspension = { suspended: boolean; by: { id: string; name: string }; at: string; reason: string };

export function createBindingState(dataDir: string) {
  const file = join(dataDir, "auth", "bindings.json");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const read = (): Record<string, BindingSuspension> => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, BindingSuspension>) : {});
  return {
    all: read,
    suspended: (name: string) => read()[name]?.suspended === true,
    set(name: string, s: BindingSuspension) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...read(), [name]: s }), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

export type BindingState = ReturnType<typeof createBindingState>;
