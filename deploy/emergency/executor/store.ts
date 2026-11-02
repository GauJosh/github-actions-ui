// Write-once snapshot storage on the executor's volume, content-addressed by manifest digest:
//
//   <data>/snapshots/<digest>/manifest.json   the manifest exactly as uploaded
//   <data>/snapshots/<digest>/record.json     name, version, storage time (not part of the digest)
//   <data>/snapshots/<digest>/files/<root>/<path>
//   <data>/executions/<id>.json and <id>.log  execution metadata and the runner's event log, kept after the Job is gone
//
// A snapshot is verified before it is stored, written to a temporary directory and renamed into place, then made
// read-only. Its directory name is its digest, so stored content can't change without changing its identity, and an
// existing digest is never overwritten. Updating a snapshot means preparing a new one: it gets the next version.
//
// Security review H1: the uploaded manifest is only a set of claims. Before storing, the executor re-runs the
// resolver over the packaged files (src/emergency/revalidate.ts) and refuses any mismatch or under-reported error;
// executability and content integrity are the executor's own findings, kept in record.json. A name belongs to the
// repository its first version came from: a later version claiming another repository is refused. Snapshots stored
// before H1 are re-validated on first use; their result is kept in <data>/validations/<digest>.json.
//
// Security review H2: the record names who stored the snapshot (the authenticated identity) and its visibility. A new
// version of a name whose latest version is restricted can be stored only by that version's preparer.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Diagnostic } from "../../../src/emergency/model.ts";
import type { Actor, Manifest, SnapshotBundle, SnapshotRecord, Visibility } from "../../../src/emergency/snapshot.ts";
import { revalidateSnapshot } from "../../../src/emergency/revalidate.ts";
import { fromBase64, manifestDigest, verifySnapshot } from "../../../src/emergency/snapshot.ts";

const DIGEST = /^[0-9a-f]{64}$/;
export const EXECUTION_ID = /^[0-9a-f]{16}$/;

export type ExecutionMeta = {
  id: string;
  snapshotId: string;
  snapshotName: string;
  snapshotVersion: number;
  workflow: string;
  inputs: Record<string, string>;
  variables: Record<string, string>;
  /** The bound Secret (bindings.ts) and the only keys mounted. */
  secretName?: string;
  secretKeys?: string[];
  /** "github-blocked" appears only in records made before the security review's C2 remediation. */
  network: "isolated" | "egress" | "github-blocked";
  /** The network check the execution was admitted on. */
  isolation?: { state: string; checkedAt?: string; reason?: string };
  createdAt: string;
  jobName: string;
  /** How its events are verified: "ed25519" since H2 (the runner's own key pair); absent before (H3 key or legacy). */
  eventAuth?: "ed25519";
  /** Security review H2. Absent on executions recorded before H2 (started with the shared operator token). */
  preparedBy?: Actor | null;
  initiatedBy?: Actor;
  /** The snapshot's visibility, which the execution inherits. */
  visibility?: Visibility;
  /** Absent before H2 = started. */
  state?: ExecutionState;
  startedAt?: string;
  approval?: ApprovalRecord;
  /** Why the request was allowed to proceed (or not), as recorded at each decision. */
  decisions?: { at: string; by: Actor; decision: string; reason: string }[];
};

export type ExecutionState = "awaiting-approval" | "approved" | "rejected" | "cancelled" | "invalidated" | "started";
export type ApprovalRecord = {
  /** Why this execution needs approval (the configured policy's triggers it met). */
  reasons: string[];
  /** sha256 over the execution's snapshot digest, workflow, inputs, variables, network and Secret binding. */
  requestDigest: string;
  expiresAt: string;
  decidedBy?: Actor;
  decidedAt?: string;
  decision?: "approved" | "rejected";
  comment?: string;
};

export function createStore(dataDir: string) {
  const snapshots = join(dataDir, "snapshots");
  const executions = join(dataDir, "executions");
  const validations = join(dataDir, "validations");
  mkdirSync(validations, { recursive: true });
  mkdirSync(snapshots, { recursive: true });
  mkdirSync(executions, { recursive: true });

  const readRecord = (id: string): SnapshotRecord | undefined => {
    if (!DIGEST.test(id)) return undefined;
    const f = join(snapshots, id, "record.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as SnapshotRecord) : undefined;
  };
  const all = () => readdirSync(snapshots).filter((d) => DIGEST.test(d)).map(readRecord).filter((r): r is SnapshotRecord => !!r);

  const makeReadOnly = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) makeReadOnly(p);
      else chmodSync(p, 0o444);
    }
    chmodSync(dir, 0o555);
  };
  const makeWritable = (dir: string) => {
    chmodSync(dir, 0o755);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) makeWritable(join(dir, e.name));
      else chmodSync(join(dir, e.name), 0o644);
    }
  };

  /** Files of a stored snapshot, for verification. */
  const storedContent = (id: string) => async (f: { root: string; path: string }) => {
    const p = join(snapshots, id, "files", ...f.root.split("/"), ...f.path.split("/"));
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
  };

  /** A record with the executor's own validation: stored with it (H1), or derived once for older snapshots. */
  const withValidation = async (record: SnapshotRecord): Promise<SnapshotRecord> => {
    if (record.validation) return record;
    const cache = join(validations, `${record.id}.json`);
    let found: Pick<SnapshotRecord, "validation" | "integrity" | "executable"> | undefined;
    if (existsSync(cache)) found = JSON.parse(readFileSync(cache, "utf8")) as typeof found;
    else {
      const m = JSON.parse(readFileSync(join(snapshots, record.id, "manifest.json"), "utf8")) as Manifest;
      const content = storedContent(record.id);
      const problems = await verifySnapshot(m, content);
      const checked = await revalidateSnapshot(m, content);
      const mismatch = [...problems.map((p) => p.message), ...checked.mismatches];
      const validation = { ...checked.validation, executable: checked.validation.executable && mismatch.length === 0, diagnostics: [...mismatch.map((message) => ({ severity: "error" as const, code: "manifest-mismatch", message })), ...checked.validation.diagnostics] };
      found = { validation, integrity: checked.integrity, executable: validation.executable };
      writeFileSync(cache, JSON.stringify(found));
    }
    return { ...record, ...found };
  };

  return {
    dataDir,
    /** The record with the executor's own validation and integrity findings (H1). */
    async checked(id: string): Promise<{ record: SnapshotRecord; manifest: Manifest } | undefined> {
      const s = this.get(id);
      return s ? { record: await withValidation(s.record), manifest: s.manifest } : undefined;
    },
    async listChecked(now = new Date()): Promise<SnapshotRecord[]> {
      return Promise.all(this.list(now).map(withValidation));
    },
    /** Verifies and stores an uploaded bundle. An identical snapshot (same digest) returns the stored record. */
    async put(bundle: SnapshotBundle, now = new Date(), owner?: { preparedBy: Actor; visibility: Visibility }): Promise<{ record?: SnapshotRecord; created: boolean; problems: Diagnostic[] }> {
      const m = bundle?.manifest as Manifest;
      if (!bundle || typeof bundle.contents !== "object" || bundle.contents === null) return { created: false, problems: [{ severity: "error", code: "bundle", message: "Body must be { manifest, contents }" }] };
      const decoded = new Map<string, Uint8Array>();
      const contentOf = async (f: { sha256: string }) => {
        if (decoded.has(f.sha256)) return decoded.get(f.sha256);
        const b64 = bundle.contents[f.sha256];
        if (typeof b64 !== "string") return undefined;
        const bytes = fromBase64(b64);
        decoded.set(f.sha256, bytes);
        return bytes;
      };
      const problems = await verifySnapshot(m, contentOf, now);
      if (problems.length) return { created: false, problems };
      for (const key of Object.keys(bundle.contents)) if (!m.files.some((f) => f.sha256 === key)) return { created: false, problems: [{ severity: "error", code: "bundle", message: "Upload contains content no file refers to" }] };
      const id = await manifestDigest(m);
      const existing = readRecord(id);
      if (existing) return { record: await withValidation(existing), created: false, problems: [] };

      // H1: the executor's own view of the pipeline, from the packaged files only.
      const checked = await revalidateSnapshot(m, contentOf, now);
      if (checked.mismatches.length) return { created: false, problems: checked.mismatches.map((message) => ({ severity: "error" as const, code: "manifest-mismatch", message })) };
      const otherRepository = all().find((r) => r.name === m.name && r.source.repository !== m.source.repository);
      if (otherRepository) {
        return {
          created: false,
          problems: [{ severity: "error", code: "name-owned", message: `The name "${m.name}" belongs to snapshots of ${otherRepository.source.repository}; a snapshot of ${m.source.repository} needs another name` }],
        };
      }
      // H2: a restricted name's next version comes only from whoever prepared its latest one.
      const latest = all().filter((r) => r.name === m.name).sort((a, b) => b.version - a.version)[0];
      if (latest?.visibility === "restricted" && latest.preparedBy?.id !== owner?.preparedBy.id) {
        return { created: false, problems: [{ severity: "error", code: "name-owned", message: `The name "${m.name}" belongs to a restricted snapshot prepared by someone else; use another name` }] };
      }

      const tmp = join(snapshots, `.tmp-${randomBytes(8).toString("hex")}`);
      try {
        mkdirSync(tmp);
        writeFileSync(join(tmp, "manifest.json"), JSON.stringify(m));
        for (const f of m.files) {
          const target = join(tmp, "files", ...f.root.split("/"), ...f.path.split("/"));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, (await contentOf(f))!);
        }
        const version = all().filter((r) => r.name === m.name).reduce((n, r) => Math.max(n, r.version), 0) + 1;
        const record: SnapshotRecord = {
          id,
          name: m.name,
          version,
          storedAt: now.toISOString(),
          expiresAt: m.expiresAt,
          source: m.source,
          entryWorkflows: m.entryWorkflows,
          executable: checked.validation.executable,
          totals: m.totals,
          validation: checked.validation,
          integrity: checked.integrity,
          ...(owner ? { preparedBy: owner.preparedBy, visibility: owner.visibility } : {}),
        };
        writeFileSync(join(tmp, "record.json"), JSON.stringify(record));
        makeReadOnly(tmp);
        renameSync(tmp, join(snapshots, id));
        return { record, created: true, problems: [] };
      } catch (error) {
        if (existsSync(tmp)) {
          makeWritable(tmp);
          rmSync(tmp, { recursive: true, force: true });
        }
        throw error;
      }
    },

    list(now = new Date()): SnapshotRecord[] {
      this.purgeExpired(now);
      return all().sort((a, b) => b.storedAt.localeCompare(a.storedAt));
    },

    get(id: string): { record: SnapshotRecord; manifest: Manifest } | undefined {
      const record = readRecord(id);
      if (!record) return undefined;
      return { record, manifest: JSON.parse(readFileSync(join(snapshots, id, "manifest.json"), "utf8")) as Manifest };
    },

    /** Re-verifies stored content against the manifest (detects changes on the volume). */
    async verifyStored(id: string, now = new Date()): Promise<Diagnostic[]> {
      const s = this.get(id);
      if (!s) return [{ severity: "error", code: "missing", message: "No such snapshot" }];
      const problems = await verifySnapshot(s.manifest, async (f) => {
        const p = join(snapshots, id, "files", ...f.root.split("/"), ...f.path.split("/"));
        return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
      }, now);
      if ((await manifestDigest(s.manifest)) !== id) problems.push({ severity: "error", code: "digest", message: "Stored manifest does not match its digest" });
      return problems;
    },

    /** Path of a snapshot relative to the data volume (what the Job mounts with subPath). */
    subPath: (id: string) => `snapshots/${id}`,

    delete(id: string): boolean {
      if (!DIGEST.test(id) || !existsSync(join(snapshots, id))) return false;
      makeWritable(join(snapshots, id));
      rmSync(join(snapshots, id), { recursive: true, force: true });
      rmSync(join(validations, `${id}.json`), { force: true });
      return true;
    },

    purgeExpired(now = new Date()): string[] {
      const removed: string[] = [];
      for (const r of all()) if (Date.parse(r.expiresAt) <= now.getTime() && this.delete(r.id)) removed.push(r.id);
      for (const d of readdirSync(snapshots)) {
        // Leftovers of interrupted uploads.
        if (d.startsWith(".tmp-") && Date.now() - statSync(join(snapshots, d)).mtimeMs > 3_600_000) {
          makeWritable(join(snapshots, d));
          rmSync(join(snapshots, d), { recursive: true, force: true });
        }
      }
      return removed;
    },

    saveExecution(meta: ExecutionMeta) {
      writeFileSync(join(executions, `${meta.id}.json`), JSON.stringify(meta));
    },
    /**
     * The key of an execution recorded between H3 and H2, which the executor generated and kept apart from the
     * metadata; since H2 the runner signs with a key pair of its own and there is no key to keep.
     */
    eventKey(id: string): string | undefined {
      const f = join(executions, `${id}.key`);
      return EXECUTION_ID.test(id) && existsSync(f) ? readFileSync(f, "utf8") : undefined;
    },
    getExecution(id: string): ExecutionMeta | undefined {
      if (!EXECUTION_ID.test(id)) return undefined;
      const f = join(executions, `${id}.json`);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ExecutionMeta) : undefined;
    },
    listExecutions(): ExecutionMeta[] {
      return readdirSync(executions)
        .filter((f) => /^[0-9a-f]{16}\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(executions, f), "utf8")) as ExecutionMeta)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    /** The runner's final log, archived once the Job has finished (Jobs are deleted after their TTL). */
    archiveLog(id: string, text: string, exitCode?: number) {
      if (!EXECUTION_ID.test(id)) return;
      writeFileSync(join(executions, `${id}.log`), text);
      // The container's exit code, kept to cross-check the runner's reported result after the Job is gone (H3).
      if (exitCode !== undefined) writeFileSync(join(executions, `${id}.exit`), String(exitCode));
    },
    archivedExitCode(id: string): number | undefined {
      const f = join(executions, `${id}.exit`);
      return EXECUTION_ID.test(id) && existsSync(f) ? Number(readFileSync(f, "utf8")) : undefined;
    },
    archivedLog(id: string): string | undefined {
      const f = join(executions, `${id}.log`);
      return EXECUTION_ID.test(id) && existsSync(f) ? readFileSync(f, "utf8") : undefined;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
