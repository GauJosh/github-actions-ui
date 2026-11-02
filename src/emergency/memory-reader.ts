// An in-memory SourceReader for tests and tools: repositories as path → text maps, each at one fixed commit.
import { gitBlobId, gitTreeId } from "./git-objects.ts";
import type { SourceReader } from "./prepare.ts";

/** `treeSha` overrides the computed tree ID (tests of a source that lies). */
export type MemoryRepo = { refs: string[]; sha: string; files: Record<string, string | Uint8Array>; executable?: string[]; treeSha?: string };

export function createMemoryReader(repos: Record<string, MemoryRepo>): SourceReader & { reads: string[] } {
  const reads: string[] = [];
  const get = (repository: string) => {
    const repo = repos[repository];
    if (!repo) throw new Error(`Not Found: ${repository}`);
    return repo;
  };
  const bytes = (v: string | Uint8Array) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  return {
    reads,
    async resolveCommit(repository, ref) {
      const repo = get(repository);
      if (ref === repo.sha || repo.refs.includes(ref)) return repo.sha;
      throw new Error(`No commit for ${ref}`);
    },
    async listFiles(repository, sha) {
      const repo = get(repository);
      if (sha !== repo.sha) throw new Error("Not Found");
      return Promise.all(
        Object.entries(repo.files).map(async ([path, v]) => ({ path, size: bytes(v).length, executable: repo.executable?.includes(path) ?? false, gitBlob: await gitBlobId(bytes(v)) })),
      );
    },
    async treeInfo(repository, sha) {
      const repo = get(repository);
      if (sha !== repo.sha) throw new Error("Not Found");
      const entries = await Promise.all(Object.entries(repo.files).map(async ([path, v]) => ({ path, blob: await gitBlobId(bytes(v)), executable: repo.executable?.includes(path) ?? false })));
      return { treeSha: repo.treeSha ?? (await gitTreeId(entries)), skipped: 0 };
    },
    async readFile(repository, sha, path) {
      const repo = get(repository);
      const v = repo.files[path];
      if (sha !== repo.sha || v === undefined) throw new Error(`Not Found: ${path}`);
      reads.push(`${repository}:${path}`);
      return bytes(v);
    },
  };
}
