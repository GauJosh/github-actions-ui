import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_REPO, DEMO_SHA, demoRepos } from "../../tools/emergency/demo-repos.ts";
import type { GitHubClient } from "../github/client";
import { GitHubError } from "../github/client";
import { createMemoryReader } from "./memory-reader.ts";
import { prepareSnapshot } from "./prepare.ts";
import { checkProvenance } from "./provenance.ts";
import { revalidateSnapshot } from "./revalidate.ts";
import type { FileEntry, Manifest } from "./snapshot.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-10-30T12:00:00Z");

async function snapshot(include?: string[]) {
  const reader = createMemoryReader(demoRepos(root));
  const { manifest, contents } = await prepareSnapshot(reader, { repository: DEMO_REPO, ref: "main", workflows: [".github/workflows/release.yml"], name: "demo", expiresInDays: 3, include }, NOW);
  const { integrity } = await revalidateSnapshot(manifest, async (f: FileEntry) => contents.get(f.sha256), NOW);
  return { manifest, integrity, reader };
}

/** A GitHub stand-in: commit trees and file lists come from a memory reader, unless overridden. */
function github(reader: ReturnType<typeof createMemoryReader>, overrides: { commitTree?: (repo: string, sha: string) => string | Error } = {}) {
  return {
    async getCommitTree(ref: { owner: string; repo: string }, sha: string) {
      const repository = `${ref.owner}/${ref.repo}`;
      const o = overrides.commitTree?.(repository, sha);
      if (o instanceof Error) throw o;
      if (o) return o;
      return (await reader.treeInfo!(repository, sha)).treeSha;
    },
    async getTree(ref: { owner: string; repo: string }, sha: string) {
      const repository = `${ref.owner}/${ref.repo}`;
      const files = await reader.listFiles(repository, sha);
      return { treeSha: (await reader.treeInfo!(repository, sha)).treeSha, skipped: 0, files: files.map((f) => ({ path: f.path, size: f.size, sha: f.gitBlob!, executable: f.executable ?? false })) };
    },
  } as unknown as GitHubClient;
}

describe("provenance against GitHub (H1)", () => {
  it("verified when GitHub's commit points to the tree the executor verified", async () => {
    const { manifest, integrity, reader } = await snapshot();
    const p = await checkProvenance(github(reader), manifest, integrity, NOW);
    expect(p.status).toBe("verified");
    expect(p.roots.map((r) => r.status)).toEqual(["verified", "verified"]);
  });

  it("failed when the claimed commit has a different tree on GitHub (mismatched commit/tree relationship)", async () => {
    const { manifest, integrity, reader } = await snapshot();
    const p = await checkProvenance(github(reader, { commitTree: (repo) => (repo === DEMO_REPO ? "9".repeat(40) : "") }), manifest, integrity, NOW);
    expect(p.status).toBe("failed");
    expect(p.roots[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/has tree 999999999999, but the snapshot claims tree/) });
  });

  it("failed when GitHub has no such commit; unverified when GitHub can't be asked", async () => {
    const { manifest, integrity, reader } = await snapshot();
    const missing = await checkProvenance(github(reader, { commitTree: () => new GitHubError({ kind: "not-found-or-no-permission" }) }), manifest, integrity, NOW);
    expect(missing.status).toBe("failed");
    const offline = await checkProvenance(github(reader, { commitTree: () => new GitHubError({ kind: "network" }) }), manifest, integrity, NOW);
    expect(offline.status).toBe("unverified");
  });

  it("a forged source repository fails: its commit doesn't exist there", async () => {
    const { manifest, integrity, reader } = await snapshot();
    const forged: Manifest = { ...manifest, roots: manifest.roots.map((r, i) => (i === 0 ? { ...r, repository: "acme/production-deploy" } : r)) };
    const p = await checkProvenance(github(reader, { commitTree: (repo) => (repo === "acme/production-deploy" ? new GitHubError({ kind: "not-found-or-no-permission" }) : "") }), forged, integrity, NOW);
    expect(p.roots[0]).toMatchObject({ status: "failed", repository: "acme/production-deploy" });
  });

  it("partial roots compare every packaged file with GitHub; one differing file fails", async () => {
    const { manifest, integrity, reader } = await snapshot(["src"]);
    expect(integrity[0]!.status).toBe("blobs-verified");
    expect((await checkProvenance(github(reader), manifest, integrity, NOW)).roots[0]!.status).toBe("verified");
    const altered: Manifest = { ...manifest, files: manifest.files.map((f) => (f.path === "src/app/VERSION" ? { ...f, gitBlob: "1".repeat(40) } : f)) };
    const p = await checkProvenance(github(reader), altered, integrity, NOW);
    expect(p.roots[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/src\/app\/VERSION/) });
  });

  it("unverified for snapshots without Git IDs, and when the executor couldn't verify the content", async () => {
    const { manifest, integrity, reader } = await snapshot();
    const legacy: Manifest = { ...manifest, roots: manifest.roots.map((r) => ({ id: r.id, repository: r.repository, ref: r.ref, sha: r.sha, kind: r.kind })) };
    expect((await checkProvenance(github(reader), legacy, integrity, NOW)).status).toBe("unverified");
    expect((await checkProvenance(github(reader), manifest, undefined, NOW)).status).toBe("unverified");
    expect(DEMO_SHA).toMatch(/^1+$/);
  });
});
