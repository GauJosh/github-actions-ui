// The emergency snapshot format: a manifest plus content-addressed files. Shared by the browser (which prepares and
// uploads it), the executor (which verifies and stores it, write-once) and the runner (which verifies it again before
// running anything). Pure: Web Crypto only, which browsers and Node 22 both provide.
import { GIT_ID, gitBlobId } from "./git-objects.ts";
import type { Diagnostic, InputSpec } from "./model.ts";
import { normalizePath } from "./model.ts";

export const SNAPSHOT_SCHEMA = "gha-emergency-snapshot/v1";
/** The runtimes the runner image provides (deploy/emergency/Dockerfile). Kept here so validation can compare. */
export const RUNNER_RUNTIMES = { node: "22", python: "3", shells: ["bash", "sh", "python"] } as const;
export const LIMITS = { maxFiles: 3000, maxBytes: 40 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, maxRepoFiles: 2000, maxDepth: 10, maxExpiryDays: 90 } as const;

/** "workspace" (the source repository at the snapshot commit) or "repo/OWNER/REPO/SHA" (an external action or workflow). */
export type RootId = string;
export const WORKSPACE: RootId = "workspace";
const ROOT = /^(?:workspace|repo\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40})$/;
export const repoRoot = (owner: string, repo: string, sha: string): RootId => `repo/${owner}/${repo}/${sha}`;
export const isRootId = (r: string) => ROOT.test(r) && !r.split("/").some((s) => s === "." || s === "..");

/**
 * A packaged file. `gitBlob` is the Git blob ID GitHub reported for it at preparation (security review H1): a claim
 * the executor and runner check against the content (content integrity). Absent in snapshots made before H1.
 */
export type FileEntry = { root: RootId; path: string; size: number; sha256: string; executable?: boolean; gitBlob?: string };

/**
 * `gitTree` is the Git tree ID GitHub reported for `sha` at preparation, and `complete` says whether every file of
 * that tree was packaged. For a complete root the executor recomputes the tree ID from the packaged content, which
 * proves the content is exactly that Git tree. That the tree belongs to commit `sha` of `repository` is a separate
 * question (provenance), which only GitHub can answer; the executor never treats it as verified.
 */
export type RootEntry = { id: RootId; repository: string; ref: string; sha: string; kind: "workspace" | "action" | "workflow"; gitTree?: string; complete?: boolean };

export type GraphStep = {
  index: number;
  label: string;
  kind: "run" | "action" | "checkout";
  shell?: string;
  /** Key into `actions`. */
  action?: string;
  scripts: string[];
};
export type GraphJob = { id: string; name?: string; needs: string[]; kind: "steps" | "call"; calls?: string; steps: GraphStep[] };
export type WorkflowEntry = { key: string; root: RootId; path: string; name?: string; jobs: GraphJob[] };

export type ActionEntry = {
  /** The `uses:` value as written ("./.github/actions/x", "owner/repo/path@v1"). */
  key: string;
  root: RootId;
  dir: string;
  file: string;
  using: string;
  runtime: string;
  /** actions/checkout of the snapshot's own commit: replaced by restoring the packaged workspace. */
  substitutedBy?: "packaged-workspace";
};

export type Requirement = { name: string; usedBy: string[] };

export type Manifest = {
  schema: typeof SNAPSHOT_SCHEMA;
  name: string;
  createdAt: string;
  expiresAt: string;
  source: { repository: string; ref: string; sha: string };
  entryWorkflows: string[];
  roots: RootEntry[];
  workflows: WorkflowEntry[];
  actions: ActionEntry[];
  files: FileEntry[];
  requirements: {
    /** Secret names only: values are supplied at execution time from a Kubernetes Secret, never stored here. */
    secrets: Requirement[];
    variables: Requirement[];
    inputs: Record<string, Record<string, InputSpec>>;
    runtimes: string[];
    externalServices: Requirement[];
  };
  diagnostics: Diagnostic[];
  totals: { files: number; bytes: number };
};

/** Base64-encoded file contents keyed by sha256: the upload body is `{ manifest, contents }`. */
export type SnapshotBundle = { manifest: Manifest; contents: Record<string, string> };

/** Stored by the executor next to the manifest; not part of the digest. */
/**
 * The executor's own findings, derived from the packaged files and never from the uploader's claims (H1).
 * - `validation`: the resolver re-run over the packaged files; `executable` is the executor's verdict.
 * - `integrity`: per root, whether the content matched its claimed Git object IDs offline.
 * Provenance (does the tree belong to the claimed commit on GitHub?) is deliberately absent: the executor can't know.
 */
export type ServerValidation = { by: "executor"; at: string; executable: boolean; diagnostics: Diagnostic[] };
export type RootIntegrity = { root: RootId; repository: string; sha: string; gitTree?: string; status: "tree-verified" | "blobs-verified" | "unverified"; detail: string };
export type SnapshotRecord = {
  id: string;
  name: string;
  version: number;
  storedAt: string;
  expiresAt: string;
  /** As claimed by the uploader (H1): the content's Git tree is checked, the commit and repository are not. */
  source: Manifest["source"];
  entryWorkflows: string[];
  /** The executor's verdict (validation.executable). */
  executable: boolean;
  totals: Manifest["totals"];
  validation?: ServerValidation;
  integrity?: RootIntegrity[];
  /** Who stored it (security review H2): the authenticated identity, never the claimed repository. Absent before H2. */
  preparedBy?: Actor;
  /** "restricted": only its preparer, approvers and administrators see it, and only its preparer runs it. Absent = shared. */
  visibility?: Visibility;
};

/** An authenticated identity as recorded on a resource: its stable ID and its display name at the time. */
export type Actor = { id: string; name: string };
export type Visibility = "shared" | "restricted";

// ---- hashing -----------------------------------------------------------------------------------------------------

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every level, so equal manifests always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The snapshot's identity: sha256 of the canonical manifest, which pins every file by its own sha256. */
export const manifestDigest = (m: Manifest) => sha256Hex(canonicalJson(m));

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- validation ----------------------------------------------------------------------------------------------------

export const hasErrors = (d: Diagnostic[]) => d.some((x) => x.severity === "error");

/**
 * Checks a manifest's structure and, when `contentOf` is given, every file's size and sha256. Returns problems as
 * error diagnostics (empty when valid). Used on upload, on storage reads and by the runner before execution.
 */
export async function verifySnapshot(manifest: unknown, contentOf?: (f: FileEntry) => Promise<Uint8Array | undefined>, now = new Date()): Promise<Diagnostic[]> {
  const problems: Diagnostic[] = [];
  const fail = (code: string, message: string) => problems.push({ severity: "error", code, message });
  const m = manifest as Manifest;
  if (!m || typeof m !== "object" || m.schema !== SNAPSHOT_SCHEMA) {
    fail("schema", `Not a ${SNAPSHOT_SCHEMA} manifest`);
    return problems;
  }
  if (typeof m.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/.test(m.name)) fail("name", "Snapshot name must be 1–63 letters, digits, spaces, dots, dashes or underscores");
  if (!/^[0-9a-f]{40}$/.test(m.source?.sha ?? "")) fail("source", "Source commit must be a full 40-character SHA");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.source?.repository ?? "")) fail("source", "Source repository must be OWNER/REPO");
  const created = Date.parse(m.createdAt);
  const expires = Date.parse(m.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) fail("expiry", "Invalid creation or expiry time");
  else if (expires - created > LIMITS.maxExpiryDays * 86_400_000) fail("expiry", `Expiry may be at most ${LIMITS.maxExpiryDays} days after creation`);
  else if (expires <= now.getTime()) fail("expired", `Snapshot expired at ${m.expiresAt}`);
  if (!Array.isArray(m.files) || !Array.isArray(m.roots) || !Array.isArray(m.workflows) || !Array.isArray(m.actions) || !Array.isArray(m.entryWorkflows)) {
    fail("structure", "Manifest is missing files, roots, workflows, actions or entry workflows");
    return problems;
  }
  const roots = new Set<string>();
  for (const r of m.roots) {
    if (!isRootId(r.id)) fail("root", `Invalid root ${JSON.stringify(r.id)}`);
    if (r.gitTree !== undefined && !GIT_ID.test(r.gitTree)) fail("root-git-tree", `Root ${r.id} has an invalid Git tree ID`);
    roots.add(r.id);
  }
  if (!roots.has(WORKSPACE)) fail("root", "The workspace root is missing");
  if (m.files.length > LIMITS.maxFiles) fail("limits", `More than ${LIMITS.maxFiles} files`);
  const seen = new Set<string>();
  let bytes = 0;
  for (const f of m.files) {
    const key = `${f.root}:${f.path}`;
    if (!roots.has(f.root)) fail("file-root", `File ${f.path} names an unknown root`);
    if (typeof f.path !== "string" || normalizePath(f.path) !== f.path || f.path === "") fail("file-path", `Unsafe file path ${JSON.stringify(f.path)}`);
    if (seen.has(key)) fail("file-duplicate", `Duplicate file ${key}`);
    seen.add(key);
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > LIMITS.maxFileBytes) fail("file-size", `File ${f.path} has an invalid size`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) fail("file-hash", `File ${f.path} has an invalid sha256`);
    if (f.gitBlob !== undefined && !GIT_ID.test(f.gitBlob)) fail("file-git-blob", `File ${f.path} has an invalid Git blob ID`);
    bytes += f.size;
  }
  if (bytes > LIMITS.maxBytes) fail("limits", `Files total more than ${LIMITS.maxBytes} bytes`);
  if (m.totals?.files !== m.files.length || m.totals?.bytes !== bytes) fail("totals", "Totals do not match the file list");
  for (const w of m.entryWorkflows) if (!seen.has(`${WORKSPACE}:${w}`)) fail("entry", `Entry workflow ${w} is not in the snapshot`);
  for (const w of m.workflows) if (!seen.has(`${w.root}:${w.path}`)) fail("workflow-file", `Workflow ${w.key} is not in the snapshot`);
  for (const a of m.actions) if (!a.substitutedBy && !seen.has(`${a.root}:${a.file}`)) fail("action-file", `Action ${a.key} is not in the snapshot`);
  if (problems.length || !contentOf) return problems;
  for (const f of m.files) {
    const content = await contentOf(f);
    if (!content) fail("content-missing", `Content of ${f.root}:${f.path} is missing`);
    else if (content.length !== f.size || (await sha256Hex(content)) !== f.sha256) fail("content-mismatch", `Content of ${f.root}:${f.path} does not match its sha256`);
    else if (f.gitBlob !== undefined && (await gitBlobId(content)) !== f.gitBlob) fail("git-blob-mismatch", `Content of ${f.root}:${f.path} is not Git blob ${f.gitBlob}`);
  }
  return problems;
}
