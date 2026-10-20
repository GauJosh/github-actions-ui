import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloneSource, fetchFixtures, httpSource, sha256, verifyFixtures, type FixtureSource } from "./fixtures.ts";
import { FixtureError, parseLock, type LockFile } from "./lockfile.ts";

const COMMIT = "a".repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);
const files = { "fixtures/a.json": enc('{"a":1}'), "fixtures/dir/b.log": enc("line 1\nline 2\n") };
const lockFor = (data: Record<string, Uint8Array>, commit = COMMIT): LockFile => ({
  repo: "GauJosh/gha-ui-fixtures",
  commit,
  files: Object.entries(data).map(([path, d]) => ({ path, bytes: d.byteLength, sha256: sha256(d) })),
});
const memorySource = (data: Record<string, Uint8Array>): FixtureSource => ({
  describe: "memory",
  async read(path) {
    const d = data[path];
    if (!d) throw new FixtureError(`HTTP 404 fetching ${path}`);
    return d;
  },
});

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "gha-ui-fixtures-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const listFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];

describe("lockfile", () => {
  it("rejects a branch name, a short SHA and a tag as the pin", () => {
    for (const commit of ["main", "184ede0", "v1.0.0"]) {
      expect(() => parseLock(JSON.stringify(lockFor(files, commit)))).toThrow(/full 40-character commit SHA/);
    }
  });
  it("rejects unsafe paths and malformed hashes", () => {
    const bad = lockFor(files);
    bad.files[0]!.path = "../escape";
    expect(() => parseLock(JSON.stringify(bad))).toThrow(/Unsafe fixture path/);
    const badHash = lockFor(files);
    badHash.files[0]!.sha256 = "abc";
    expect(() => parseLock(JSON.stringify(badHash))).toThrow(/Invalid SHA-256/);
  });
  it("accepts the committed lockfile", () => {
    const lock = parseLock(readFileSync("fixtures.lock.json", "utf8"));
    expect(lock.commit).toBe("184ede06780166a90bdb173adda9a23a5b6545c4");
    expect(lock.files.length).toBeGreaterThan(0);
  });
});

describe("fetchFixtures", () => {
  it("writes verified files and skips files already present", async () => {
    const out = tempDir();
    const lock = lockFor(files);
    expect(await fetchFixtures({ lock, outRoot: out, source: memorySource(files) })).toEqual({ fetched: 2, skipped: 0 });
    expect(await fetchFixtures({ lock, outRoot: out, source: memorySource(files) })).toEqual({ fetched: 0, skipped: 2 });
    expect(verifyFixtures(lock, out)).toEqual([]);
  });

  it("fails on a SHA-256 mismatch and leaves no partial file", async () => {
    const out = tempDir();
    const lock = lockFor(files);
    const tampered = { ...files, "fixtures/a.json": enc('{"a":2}') };
    await expect(fetchFixtures({ lock, outRoot: out, source: memorySource(tampered), concurrency: 1 })).rejects.toThrow(
      /SHA-256 mismatch for fixtures\/a.json: expected [0-9a-f]{64}, got [0-9a-f]{64}/,
    );
    expect(listFiles(out).filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(existsSync(join(out, COMMIT, "fixtures/a.json"))).toBe(false);
  });

  it("fails on a size mismatch", async () => {
    const lock = lockFor(files);
    const longer = { ...files, "fixtures/a.json": enc('{"a":10}') };
    await expect(fetchFixtures({ lock, outRoot: tempDir(), source: memorySource(longer) })).rejects.toThrow(/Size mismatch/);
  });

  it("fails on a missing file", async () => {
    const lock = lockFor(files);
    const partial = Object.fromEntries(Object.entries(files).filter(([p]) => p !== "fixtures/dir/b.log"));
    await expect(fetchFixtures({ lock, outRoot: tempDir(), source: memorySource(partial) })).rejects.toThrow(/fixtures\/dir\/b.log/);
  });

  it("reports HTTP errors and sends no credentials to the pinned commit URL", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    const lock = lockFor(files);
    await expect(fetchFixtures({ lock, outRoot: tempDir(), source: httpSource(lock, fakeFetch), concurrency: 1 })).rejects.toThrow(
      /HTTP 500 fetching fixtures\/a.json/,
    );
    expect(seen[0]!.url).toBe(`https://raw.githubusercontent.com/GauJosh/gha-ui-fixtures/${COMMIT}/fixtures/a.json`);
    expect(seen[0]!.init?.headers).toBeUndefined();
  });

  it("verifyFixtures reports missing and altered files", async () => {
    const out = tempDir();
    const lock = lockFor(files);
    await fetchFixtures({ lock, outRoot: out, source: memorySource(files) });
    writeFileSync(join(out, COMMIT, "fixtures/a.json"), "changed");
    rmSync(join(out, COMMIT, "fixtures/dir/b.log"));
    expect(verifyFixtures(lock, out)).toEqual(["size or SHA-256 mismatch: fixtures/a.json", "missing: fixtures/dir/b.log"]);
  });
});

describe("cloneSource (offline)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" }).trim();

  it("reads files at the pinned commit, not the checked-out branch", async () => {
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    mkdirSync(join(repo, "fixtures/dir"), { recursive: true });
    for (const [p, d] of Object.entries(files)) writeFileSync(join(repo, p), d);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "pinned");
    const pinned = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "fixtures/a.json"), "moved on");
    git(repo, "commit", "-q", "-am", "later");

    const lock = lockFor(files, pinned);
    const out = tempDir();
    await fetchFixtures({ lock, outRoot: out, source: cloneSource(lock, repo) });
    expect(readFileSync(join(out, pinned, "fixtures/a.json"), "utf8")).toBe('{"a":1}');
  });

  it("fails when the clone lacks the pinned commit", () => {
    const repo = tempDir();
    git(repo, "init", "-q");
    expect(() => cloneSource(lockFor(files, "b".repeat(40)), repo)).toThrow(/does not contain commit/);
  });
});
