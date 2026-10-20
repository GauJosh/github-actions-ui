// Re-pins the fixture lockfile. Explicit by design: it needs a full commit SHA and a local clone
// containing that commit, and it never resolves a branch. Review the resulting diff before committing.
// Usage: node tools/fixtures/lock.ts --commit <40-char sha> --from <path-to-local-clone> [--lock fixtures.lock.json]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cloneSource, sha256 } from "./fixtures.ts";
import { FixtureError, assertCommitSha, assertSafePath, formatLock, type LockFile } from "./lockfile.ts";

const REPO = "GauJosh/gha-ui-fixtures";
const { values } = parseArgs({
  options: {
    commit: { type: "string" },
    from: { type: "string" },
    lock: { type: "string", default: "fixtures.lock.json" },
  },
});

try {
  const commit = assertCommitSha(values.commit);
  if (!values.from) throw new FixtureError("--from <path-to-local-clone> is required");
  const lock: LockFile = { repo: REPO, commit, files: [] };
  const source = cloneSource(lock, values.from);
  const listing = execFileSync("git", ["-C", values.from, "ls-tree", "-r", "-l", "--full-tree", commit, "--", "fixtures"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of listing.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t") as [string, string];
    const size = Number(meta.trim().split(/\s+/)[3]);
    const data = await source.read(assertSafePath(path));
    if (data.byteLength !== size) throw new FixtureError(`Size disagreement for ${path}: tree ${size}, blob ${data.byteLength}`);
    lock.files.push({ path, bytes: data.byteLength, sha256: sha256(data) });
  }
  if (lock.files.length === 0) throw new FixtureError(`No fixtures/ files at ${commit}`);
  writeFileSync(values.lock, formatLock(lock));
  console.log(`fixtures: wrote ${values.lock} (${lock.files.length} files at ${commit})`);
} catch (error) {
  if (!(error instanceof FixtureError)) throw error;
  console.error(`fixtures: FAILED: ${error.message}`);
  process.exit(1);
}
