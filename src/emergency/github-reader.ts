// Snapshot preparation's view of GitHub: the app's read-only client (GET only, the existing token and permissions).
// Files are read by blob SHA from the commit's tree, so every byte comes from the pinned commit.
import type { GitHubClient } from "../github/client";
import type { SourceReader, TreeFile } from "./prepare.ts";

const split = (repository: string) => {
  const [owner, repo] = repository.split("/") as [string, string];
  return { owner, repo };
};

export function createGitHubReader(client: GitHubClient): SourceReader {
  type Tree = { treeSha: string; skipped: number; files: Map<string, { size: number; sha: string; executable: boolean }> };
  const trees = new Map<string, Promise<Tree>>();
  const load = (repository: string, sha: string) => {
    const key = `${repository}@${sha}`;
    let tree = trees.get(key);
    if (!tree) {
      tree = client.getTree(split(repository), sha).then((t) => ({ treeSha: t.treeSha, skipped: t.skipped, files: new Map(t.files.map((e) => [e.path, e])) }));
      trees.set(key, tree);
    }
    return tree;
  };
  const treeOf = async (repository: string, sha: string) => (await load(repository, sha)).files;
  return {
    resolveCommit: (repository, ref) => client.resolveCommit(split(repository), ref),
    async listFiles(repository, sha): Promise<TreeFile[]> {
      return [...(await treeOf(repository, sha)).entries()].map(([path, e]) => ({ path, size: e.size, executable: e.executable, gitBlob: e.sha }));
    },
    async readFile(repository, sha, path) {
      const entry = (await treeOf(repository, sha)).get(path);
      if (!entry) throw new Error(`${path} is not in ${repository}@${sha.slice(0, 7)}`);
      return client.getBlob(split(repository), entry.sha);
    },
    async treeInfo(repository, sha) {
      const t = await load(repository, sha);
      return { treeSha: t.treeSha, skipped: t.skipped };
    },
  };
}
