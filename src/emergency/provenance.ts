// Provenance of a stored snapshot (security review H1), checked live in the browser against GitHub with the
// operator's own read-only token. It answers the question the executor can't: is the content the executor verified
// (content integrity, a Git tree or Git blobs) really the claimed commit of the claimed repository?
// - verified: GitHub says the commit exists and points to the tree whose content the executor verified (or, for a
//   partial root, every packaged file has GitHub's blob ID at that path and mode);
// - failed: GitHub contradicts the snapshot (no such commit, another tree, other files);
// - unverified: it can't be decided (no Git IDs in the snapshot, the executor couldn't verify the content, or GitHub
//   couldn't be asked).
// The result is shown to whoever asked and never sent to the executor, which must not rely on a client's claim.
import type { GitHubClient } from "../github/client";
import { GitHubError } from "../github/client";
import type { Manifest, RootIntegrity } from "./snapshot.ts";

export type ProvenanceStatus = "verified" | "failed" | "unverified";
export type RootProvenance = { repository: string; sha: string; kind: string; status: ProvenanceStatus; detail: string };
export type Provenance = { status: ProvenanceStatus; checkedAt: string; roots: RootProvenance[] };

const repoRef = (repository: string) => {
  const [owner, repo] = repository.split("/") as [string, string];
  return { owner, repo };
};

export async function checkProvenance(client: GitHubClient, manifest: Manifest, integrity: RootIntegrity[] | undefined, now = new Date()): Promise<Provenance> {
  const roots: RootProvenance[] = [];
  for (const root of manifest.roots) {
    const base = { repository: root.repository, sha: root.sha, kind: root.kind };
    const verifiedContent = integrity?.find((i) => i.root === root.id);
    if (!root.gitTree) {
      roots.push({ ...base, status: "unverified", detail: "The snapshot has no Git object IDs (prepared before they were recorded)" });
      continue;
    }
    let commitTree: string;
    try {
      commitTree = await client.getCommitTree(repoRef(root.repository), root.sha);
    } catch (error) {
      const missing = error instanceof GitHubError && (error.failure.kind === "not-found-or-no-permission" || (error.failure.kind === "http-error" && error.failure.status === 422));
      roots.push({
        ...base,
        status: missing ? "failed" : "unverified",
        detail: missing ? `GitHub has no commit ${root.sha} in ${root.repository} (or this token can't see it)` : `GitHub could not be asked: ${(error as Error).message}`,
      });
      continue;
    }
    if (commitTree !== root.gitTree) {
      roots.push({ ...base, status: "failed", detail: `On GitHub, commit ${root.sha.slice(0, 12)} has tree ${commitTree.slice(0, 12)}, but the snapshot claims tree ${root.gitTree.slice(0, 12)}` });
      continue;
    }
    if (verifiedContent?.status === "tree-verified") {
      roots.push({ ...base, status: "verified", detail: `GitHub: commit ${root.sha.slice(0, 12)} has tree ${commitTree.slice(0, 12)}; the executor verified the packaged files are exactly that tree` });
      continue;
    }
    if (verifiedContent?.status === "blobs-verified") {
      const packaged = manifest.files.filter((f) => f.root === root.id);
      let tree: Awaited<ReturnType<GitHubClient["getTree"]>>;
      try {
        tree = await client.getTree(repoRef(root.repository), root.sha);
      } catch (error) {
        roots.push({ ...base, status: "unverified", detail: `GitHub's file list could not be read: ${(error as Error).message}` });
        continue;
      }
      const onGitHub = new Map(tree.files.map((f) => [f.path, f]));
      const wrong = packaged.filter((f) => onGitHub.get(f.path)?.sha !== f.gitBlob || (onGitHub.get(f.path)?.executable ?? false) !== (f.executable ?? false));
      roots.push(
        wrong.length
          ? { ...base, status: "failed", detail: `${wrong.length} packaged file(s) differ from commit ${root.sha.slice(0, 12)} on GitHub, e.g. ${wrong[0]!.path}` }
          : { ...base, status: "verified", detail: `GitHub: commit ${root.sha.slice(0, 12)} has tree ${commitTree.slice(0, 12)}, and all ${packaged.length} packaged files match it` },
      );
      continue;
    }
    roots.push({ ...base, status: "unverified", detail: "The executor could not verify this content against its Git IDs" });
  }
  const status: ProvenanceStatus = roots.some((r) => r.status === "failed") ? "failed" : roots.length > 0 && roots.every((r) => r.status === "verified") ? "verified" : "unverified";
  return { status, checkedAt: now.toISOString(), roots };
}
