// Server-side validation of an uploaded snapshot (security review H1). The uploader's manifest is a set of claims:
// its graph, actions, requirements, diagnostics, executability and Git object IDs. Here the same resolver
// (prepare.ts) is re-run over the packaged files alone, so every claim is checked against the content:
// - any difference in roots, workflows, actions, requirements, files or totals is a mismatch (the upload is refused);
// - an error the executor finds that the manifest doesn't report is a mismatch (under-reported errors);
// - executability is derived here: no errors from this run, and none the uploader declared (they can only be stricter);
// - content integrity per root: a complete root's Git tree ID is recomputed from the content; otherwise each file's
//   Git blob ID is checked (by verifySnapshot), or nothing can be (snapshots made before H1).
// Provenance, whether that tree really is the claimed commit of the claimed repository on GitHub, is not decided
// here: the executor can't reach GitHub. The UI checks it live with the operator's own token and shows the result.
// Callers run verifySnapshot with content first (sizes, sha256 and Git blob IDs of every file).
import { gitTreeId } from "./git-objects.ts";
import type { Diagnostic } from "./model.ts";
import { prepareSnapshot, type SourceReader, type TreeFile } from "./prepare.ts";
import type { FileEntry, Manifest, RootIntegrity, ServerValidation } from "./snapshot.ts";
import { canonicalJson, hasErrors, LIMITS } from "./snapshot.ts";

export type Revalidation = { validation: ServerValidation; integrity: RootIntegrity[]; mismatches: string[] };

/** A SourceReader over the packaged files: it can resolve only what the snapshot contains. */
export function packagedReader(m: Manifest, contentOf: (f: FileEntry) => Promise<Uint8Array | undefined>): SourceReader {
  const byCommit = new Map<string, Map<string, FileEntry>>();
  for (const f of m.files) {
    const root = m.roots.find((r) => r.id === f.root);
    if (!root) continue;
    const key = `${root.repository}@${root.sha}`;
    if (!byCommit.has(key)) byCommit.set(key, new Map());
    byCommit.get(key)!.set(f.path, f);
  }
  const files = (repository: string, sha: string) => {
    const set = byCommit.get(`${repository}@${sha}`);
    if (!set) throw new Error(`${repository}@${sha.slice(0, 7)} is not packaged in this snapshot`);
    return set;
  };
  return {
    async resolveCommit(repository, ref) {
      const root = m.roots.find((r) => r.repository === repository && (r.ref === ref || r.sha === ref));
      if (!root) throw new Error(`${repository}@${ref} is not packaged in this snapshot`);
      return root.sha;
    },
    async listFiles(repository, sha): Promise<TreeFile[]> {
      return [...files(repository, sha).values()].map((f) => ({ path: f.path, size: f.size, executable: f.executable ?? false, ...(f.gitBlob ? { gitBlob: f.gitBlob } : {}) }));
    },
    async readFile(repository, sha, path) {
      const f = files(repository, sha).get(path);
      const data = f ? await contentOf(f) : undefined;
      if (!data) throw new Error(`${path} is not packaged in ${repository}@${sha.slice(0, 7)}`);
      return data;
    },
    async treeInfo(repository, sha) {
      const root = m.roots.find((r) => r.repository === repository && r.sha === sha && r.gitTree);
      return root?.gitTree ? { treeSha: root.gitTree, skipped: 0 } : { treeSha: "", skipped: 0 };
    },
  };
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const diagKey = (d: Diagnostic) => `${d.code}|${d.where ?? ""}|${d.message}`;

export async function revalidateSnapshot(m: Manifest, contentOf: (f: FileEntry) => Promise<Uint8Array | undefined>, now = new Date()): Promise<Revalidation> {
  const mismatches: string[] = [];
  const days = Math.min(LIMITS.maxExpiryDays, Math.max(1, Math.round((Date.parse(m.expiresAt) - Date.parse(m.createdAt)) / 86_400_000)));
  let rebuilt: Manifest | undefined;
  try {
    rebuilt = (
      await prepareSnapshot(
        packagedReader(m, contentOf),
        { repository: m.source.repository, ref: m.source.ref, sha: m.source.sha, workflows: m.entryWorkflows, name: m.name, expiresInDays: days },
        new Date(m.createdAt),
      )
    ).manifest;
  } catch (error) {
    mismatches.push(`The executor could not rebuild the pipeline from the packaged files: ${(error as Error).message}`);
  }

  let diagnostics: Diagnostic[] = [{ severity: "error", code: "server-rebuild", message: mismatches[0] ?? "not rebuilt" }];
  if (rebuilt) {
    diagnostics = rebuilt.diagnostics;
    const strip = (r: Manifest["roots"][number]) => ({ id: r.id, repository: r.repository, ref: r.ref, sha: r.sha, kind: r.kind });
    const fileView = (f: FileEntry) => ({ root: f.root, path: f.path, size: f.size, sha256: f.sha256, executable: f.executable ?? false, gitBlob: f.gitBlob ?? null });
    const checks: [string, unknown, unknown][] = [
      ["roots", m.roots.map(strip), rebuilt.roots.map(strip)],
      ["entry workflows", m.entryWorkflows, rebuilt.entryWorkflows],
      ["execution graph", m.workflows, rebuilt.workflows],
      ["actions", m.actions, rebuilt.actions],
      ["requirements", m.requirements, rebuilt.requirements],
      ["files", m.files.map(fileView), rebuilt.files.map(fileView)],
      ["totals", m.totals, rebuilt.totals],
    ];
    for (const [what, claimed, derived] of checks) if (!same(claimed, derived)) mismatches.push(`The manifest's ${what} do not match what the packaged files produce`);
    const claimed = new Set(m.diagnostics.filter((d) => d.severity === "error").map(diagKey));
    const missing = rebuilt.diagnostics.filter((d) => d.severity === "error" && !claimed.has(diagKey(d)));
    if (missing.length) mismatches.push(`The manifest under-reports validation errors: ${missing.map((d) => d.message).join("; ")}`);
  }

  const integrity: RootIntegrity[] = [];
  for (const root of m.roots) {
    const files = m.files.filter((f) => f.root === root.id);
    const allBlobs = files.length > 0 && files.every((f) => f.gitBlob);
    if (root.gitTree && root.complete && allBlobs) {
      const tree = await gitTreeId(files.map((f) => ({ path: f.path, blob: f.gitBlob!, executable: f.executable ?? false })));
      if (tree === root.gitTree) integrity.push({ root: root.id, repository: root.repository, sha: root.sha, gitTree: root.gitTree, status: "tree-verified", detail: `All ${files.length} files together are Git tree ${tree}` });
      else {
        mismatches.push(`The packaged files of ${root.repository} are Git tree ${tree}, not the claimed ${root.gitTree}`);
        integrity.push({ root: root.id, repository: root.repository, sha: root.sha, gitTree: root.gitTree, status: "unverified", detail: `Content is tree ${tree}, not ${root.gitTree}` });
      }
    } else if (allBlobs) {
      integrity.push({ root: root.id, repository: root.repository, sha: root.sha, gitTree: root.gitTree, status: "blobs-verified", detail: `Each of ${files.length} files matches its Git blob ID; the root is partial, so its tree ID can't be recomputed` });
    } else {
      integrity.push({ root: root.id, repository: root.repository, sha: root.sha, gitTree: root.gitTree, status: "unverified", detail: files.length ? "The snapshot predates Git object IDs (prepared before H1)" : "No files packaged from this root" });
    }
  }

  const executable = mismatches.length === 0 && !hasErrors(diagnostics) && !hasErrors(m.diagnostics);
  return { validation: { by: "executor", at: now.toISOString(), executable, diagnostics }, integrity, mismatches };
}
