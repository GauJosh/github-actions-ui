import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_REPO, DEMO_SHA, demoRepos, SHARED_SHA } from "../../tools/emergency/demo-repos.ts";
import { createMemoryReader, type MemoryRepo } from "./memory-reader.ts";
import { prepareSnapshot, PrepareError } from "./prepare.ts";
import { hasErrors, manifestDigest, verifySnapshot, type FileEntry } from "./snapshot.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const NOW = new Date("2026-10-30T12:00:00Z");
const opts = { repository: DEMO_REPO, ref: "main", workflows: [".github/workflows/release.yml"], name: "release demo", expiresInDays: 30 };

async function prepareDemo() {
  return prepareSnapshot(createMemoryReader(demoRepos(root)), opts, NOW);
}

/** A one-repository fixture with the given workflow (and extra files). */
function single(workflow: string, extra: Record<string, string> = {}): Record<string, MemoryRepo> {
  return { "o/r": { refs: ["main"], sha: "a".repeat(40), files: { ".github/workflows/w.yml": workflow, ...extra } } };
}
async function diagnose(repos: Record<string, MemoryRepo>) {
  const { manifest } = await prepareSnapshot(createMemoryReader(repos), { ...opts, repository: "o/r", workflows: [".github/workflows/w.yml"] }, NOW);
  return manifest.diagnostics;
}
const codes = (d: { severity: string; code: string }[], severity = "error") => d.filter((x) => x.severity === severity).map((x) => x.code);

describe("snapshot preparation of the demo pipeline", () => {
  it("resolves the reusable workflow, local, external and composite actions, pinned to commits", async () => {
    const { manifest } = await prepareDemo();
    expect(manifest.source).toEqual({ repository: DEMO_REPO, ref: "main", sha: DEMO_SHA });
    expect(manifest.workflows.map((w) => w.key)).toEqual([".github/workflows/release.yml", "./.github/workflows/build.yml"]);
    const release = manifest.workflows[0]!;
    expect(release.jobs.map((j) => [j.id, j.kind, j.needs, j.calls])).toEqual([
      ["prepare", "steps", [], undefined],
      ["build", "call", ["prepare"], "./.github/workflows/build.yml"],
      ["report", "steps", ["prepare", "build"], undefined],
    ]);
    const byKey = Object.fromEntries(manifest.actions.map((a) => [a.key, a]));
    expect(byKey["actions/checkout@v4"]).toMatchObject({ substitutedBy: "packaged-workspace" });
    expect(byKey["./.github/actions/stamp"]).toMatchObject({ using: "node", runtime: "node20", root: "workspace", file: ".github/actions/stamp/action.yml" });
    expect(byKey["demo-org/shared-actions/notify@v1"]).toMatchObject({ using: "node", root: `repo/demo-org/shared-actions/${SHARED_SHA}`, dir: "notify" });
    expect(byKey["./.github/actions/summarize"]).toMatchObject({ using: "composite" });
    const build = manifest.workflows[1]!;
    expect(build.jobs.find((j) => j.id === "package")!.steps.flatMap((s) => s.scripts)).toEqual(["scripts/checksum.py", "scripts/verify.sh"]);
  });

  it("records required secret names (never values), inputs and runtimes, and has no blocking errors", async () => {
    const { manifest } = await prepareDemo();
    expect(manifest.requirements.secrets.map((s) => s.name)).toEqual(["DEMO_SIGNING_KEY"]);
    expect(Object.keys(manifest.requirements.inputs[".github/workflows/release.yml"]!)).toEqual(["version"]);
    expect(manifest.requirements.runtimes).toEqual(["bash", "node", "python"]);
    expect(hasErrors(manifest.diagnostics)).toBe(false);
    expect(codes(manifest.diagnostics, "warning")).toContain("node-runtime");
    expect(codes(manifest.diagnostics, "info")).toEqual(expect.arrayContaining(["checkout-substituted", "triggers", "pinned"]));
    expect(JSON.stringify(manifest)).not.toMatch(/signing-key-value/);
  });

  it("packages every file with its sha256 and verifies; tampering, removal and expiry are detected", async () => {
    const { manifest, contents } = await prepareDemo();
    const contentOf = async (f: FileEntry) => contents.get(f.sha256);
    expect(await verifySnapshot(manifest, contentOf, NOW)).toEqual([]);
    expect(manifest.files.find((f) => f.path === "scripts/verify.sh")).toMatchObject({ executable: true });
    expect(manifest.files.some((f) => f.root.startsWith("repo/demo-org/shared-actions/") && f.path === "notify/index.js")).toBe(true);

    const tampered = new Map(contents);
    const target = manifest.files.find((f) => f.path === "scripts/build.sh")!;
    tampered.set(target.sha256, new TextEncoder().encode("rm -rf /\n"));
    expect((await verifySnapshot(manifest, async (f) => tampered.get(f.sha256), NOW)).map((d) => d.code)).toEqual(["content-mismatch"]);
    expect((await verifySnapshot({ ...manifest, files: manifest.files.slice(1) }, contentOf, NOW)).map((d) => d.code)).toContain("totals");
    expect((await verifySnapshot({ ...manifest, files: [{ ...target, path: "../escape.sh" }, ...manifest.files] }, undefined, NOW)).map((d) => d.code)).toContain("file-path");
    expect((await verifySnapshot(manifest, contentOf, new Date("2027-01-01T00:00:00Z"))).map((d) => d.code)).toEqual(["expired"]);
  });

  it("is deterministic: the same commit gives the same digest; a changed file gives a new one", async () => {
    const a = await prepareDemo();
    const b = await prepareDemo();
    expect(await manifestDigest(a.manifest)).toBe(await manifestDigest(b.manifest));
    const repos = demoRepos(root);
    repos[DEMO_REPO]!.files["src/app/main.txt"] = "changed\n";
    const c = await prepareSnapshot(createMemoryReader(repos), opts, NOW);
    expect(await manifestDigest(c.manifest)).not.toBe(await manifestDigest(a.manifest));
  });

  it("packages only the selected supporting files, and refuses to drop a script a step uses", async () => {
    const { manifest } = await prepareSnapshot(createMemoryReader(demoRepos(root)), { ...opts, include: ["src"] }, NOW);
    const ws = manifest.files.filter((f) => f.root === "workspace").map((f) => f.path);
    expect(ws.some((p) => p.startsWith(".github/"))).toBe(true);
    expect(ws).not.toContain("README.md");
    expect(codes(manifest.diagnostics)).toContain("excluded-script");
  });
});

describe("snapshot validation refuses what the runner cannot reproduce", () => {
  const job = (body: string) => `on: workflow_dispatch\njobs:\n  j:\n    runs-on: ubuntu-latest\n${body}`;

  it("matrix, services and containers", async () => {
    expect(codes(await diagnose(single(job("    strategy:\n      matrix:\n        n: [1, 2]\n    steps:\n      - run: echo ${{ matrix.n }}\n"))))).toEqual(expect.arrayContaining(["job-feature", "matrix"]));
    expect(codes(await diagnose(single(job("    services:\n      db:\n        image: postgres\n    steps:\n      - run: true\n"))))).toContain("job-feature");
  });

  it("GitHub-issued credentials and event payloads", async () => {
    const d = await diagnose(single(job("    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }} ${{ github.token }} ${{ github.event.head_commit.id }}\n")));
    expect(codes(d)).toEqual(expect.arrayContaining(["github-token", "event-payload"]));
  });

  it("unsupported functions, shells, Docker actions and GitHub-service actions", async () => {
    const d = await diagnose(single(job("    steps:\n      - run: echo ${{ hashFiles('x') }}\n      - run: Get-Date\n        shell: pwsh\n      - uses: docker://alpine:3\n      - uses: actions/upload-artifact@v4\n")));
    expect(codes(d)).toEqual(expect.arrayContaining(["function", "shell", "docker-action", "github-service"]));
  });

  it("JavaScript actions with deprecated runtimes, pre: scripts or unpackaged dependencies", async () => {
    const d = await diagnose(
      single(job("    steps:\n      - uses: ./a\n      - uses: ./b\n"), {
        "a/action.yml": "runs:\n  using: node16\n  main: index.js\n",
        "a/index.js": "",
        "b/action.yml": "runs:\n  using: node20\n  main: index.js\n  pre: setup.js\n",
        "b/index.js": "const core = require('@actions/core'); const fs = require('node:fs');",
      }),
    );
    expect(codes(d)).toEqual(expect.arrayContaining(["node-runtime", "action-pre", "action-dependency"]));
    expect(d.find((x) => x.code === "action-dependency")!.message).toMatch(/@actions\/core/);
  });

  it("reusable workflow problems: undeclared inputs, missing required secrets, cycles", async () => {
    const d = await diagnose(
      single("on: workflow_dispatch\njobs:\n  call:\n    uses: ./.github/workflows/c.yml\n    with:\n      nope: 1\n", {
        ".github/workflows/c.yml": "on:\n  workflow_call:\n    secrets:\n      key:\n        required: true\njobs:\n  again:\n    uses: ./.github/workflows/c.yml\n",
      }),
    );
    expect(codes(d)).toEqual(expect.arrayContaining(["reusable-input", "reusable-secret", "cycle"]));
  });

  it("refuses input it cannot prepare", async () => {
    await expect(prepareSnapshot(createMemoryReader(single("jobs: {}")), { ...opts, repository: "o/r", workflows: ["README.md"] }, NOW)).rejects.toThrow(PrepareError);
    await expect(prepareSnapshot(createMemoryReader(single("jobs: {}")), { ...opts, repository: "o/r", workflows: [".github/workflows/w.yml"], expiresInDays: 365 }, NOW)).rejects.toThrow(/Expiry/);
  });
});
