import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitBlobId, gitTreeId } from "./git-objects.ts";

const enc = new TextEncoder();

/** A tree with the orderings git is particular about: "a" vs "a.b" vs "a/", "a-b", nested dirs, executables, empty file. */
const FILES: { path: string; content: string; executable?: boolean }[] = [
  { path: "a", content: "file a\n" },
  { path: "a.b", content: "dot\n" },
  { path: "a-b", content: "dash\n" },
  { path: "ab/x.txt", content: "nested\n" },
  { path: "a.d/y", content: "dir with dot\n" },
  { path: "dir/sub/deep.sh", content: "#!/bin/sh\necho hi\n", executable: true },
  { path: "dir/z", content: "" },
  { path: "Upper.txt", content: "case\n" },
];

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

describe("git object IDs", () => {
  it("blob IDs match git's well-known values", async () => {
    expect(await gitBlobId(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await gitBlobId(enc.encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it.skipIf(!hasGit)("tree IDs match the git binary, including its directory ordering and executable bits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-tree-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "core.fileMode", "true"], { cwd: dir });
      for (const f of FILES) {
        const p = join(dir, ...f.path.split("/"));
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, f.content);
        if (f.executable) chmodSync(p, 0o755);
      }
      execFileSync("git", ["add", "-A"], { cwd: dir });
      // Windows can't record the executable bit from the filesystem; set it in the index explicitly.
      for (const f of FILES.filter((x) => x.executable)) execFileSync("git", ["update-index", "--chmod=+x", f.path], { cwd: dir });
      const expected = execFileSync("git", ["write-tree"], { cwd: dir }).toString().trim();
      const entries = await Promise.all(FILES.map(async (f) => ({ path: f.path, blob: await gitBlobId(enc.encode(f.content)), executable: !!f.executable })));
      expect(await gitTreeId(entries)).toBe(expected);
      // One changed byte, or a changed executable bit, changes the tree ID.
      expect(await gitTreeId(entries.map((e, i) => (i === 0 ? { ...e, executable: true } : e)))).not.toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
