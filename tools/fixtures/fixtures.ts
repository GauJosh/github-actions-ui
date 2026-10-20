// Fetches and checks pinned fixture files. Every file is written to a temporary name, checked for
// size and SHA-256, and only then renamed into place; a failure deletes the partial file and stops.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FixtureError, assertCommitSha, type LockFile, type LockedFile } from "./lockfile.ts";

export type FixtureSource = { describe: string; read(path: string): Promise<Uint8Array> };

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function fixtureDir(outRoot: string, lock: LockFile): string {
  return join(outRoot, lock.commit);
}

/** Downloads from GitHub's raw-content host at the pinned commit. Never sends credentials. */
export function httpSource(lock: LockFile, fetchImpl: typeof fetch = fetch): FixtureSource {
  const base = `https://raw.githubusercontent.com/${lock.repo}/${assertCommitSha(lock.commit)}/`;
  return {
    describe: `raw.githubusercontent.com (${lock.repo} @ ${lock.commit})`,
    async read(path) {
      let response: Response;
      try {
        response = await fetchImpl(base + path.split("/").map(encodeURIComponent).join("/"), { credentials: "omit" });
      } catch (error) {
        throw new FixtureError(`Network error fetching ${path}: ${(error as Error).message}`);
      }
      if (response.status !== 200) throw new FixtureError(`HTTP ${response.status} fetching ${path}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** Reads files out of a local clone at the pinned commit (not its checked-out branch), for offline use. */
export function cloneSource(lock: LockFile, clonePath: string): FixtureSource {
  const commit = assertCommitSha(lock.commit);
  try {
    execFileSync("git", ["-C", clonePath, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
  } catch {
    throw new FixtureError(`Local clone ${clonePath} does not contain commit ${commit}. Fetch it in that clone first.`);
  }
  return {
    describe: `local clone ${clonePath} @ ${commit}`,
    async read(path) {
      try {
        const out = execFileSync("git", ["-C", clonePath, "show", `${commit}:${path}`], { maxBuffer: 256 * 1024 * 1024 });
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
      } catch {
        throw new FixtureError(`File ${path} is missing at commit ${commit} in ${clonePath}`);
      }
    },
  };
}

function matches(target: string, file: LockedFile): boolean {
  return existsSync(target) && statSync(target).size === file.bytes && sha256(readFileSync(target)) === file.sha256;
}

function check(file: LockedFile, data: Uint8Array): void {
  if (data.byteLength !== file.bytes) {
    throw new FixtureError(`Size mismatch for ${file.path}: expected ${file.bytes} bytes, got ${data.byteLength}`);
  }
  const actual = sha256(data);
  if (actual !== file.sha256) throw new FixtureError(`SHA-256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`);
}

export async function fetchFixtures(options: {
  lock: LockFile;
  outRoot: string;
  source: FixtureSource;
  concurrency?: number;
}): Promise<{ fetched: number; skipped: number }> {
  const { lock, outRoot, source } = options;
  const dir = fixtureDir(outRoot, lock);
  const queue = [...lock.files];
  let fetched = 0;
  let skipped = 0;
  let failure: unknown = null;

  async function worker(): Promise<void> {
    for (let file = queue.shift(); file && !failure; file = queue.shift()) {
      const target = join(dir, file.path);
      if (matches(target, file)) {
        skipped++;
        continue;
      }
      const part = `${target}.part`;
      try {
        const data = await source.read(file.path);
        check(file, data);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(part, data);
        renameSync(part, target);
        fetched++;
      } catch (error) {
        rmSync(part, { force: true });
        failure ??= error;
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency ?? 6 }, worker));
  if (failure) throw failure;
  return { fetched, skipped };
}

/** Checks the prepared fixture directory against the lockfile without any network access. */
export function verifyFixtures(lock: LockFile, outRoot: string): string[] {
  const dir = fixtureDir(outRoot, lock);
  const problems: string[] = [];
  for (const file of lock.files) {
    const target = join(dir, file.path);
    if (!existsSync(target)) problems.push(`missing: ${file.path}`);
    else if (!matches(target, file)) problems.push(`size or SHA-256 mismatch: ${file.path}`);
  }
  return problems;
}

export const NOT_PREPARED = "Fixtures not prepared: run `npm run fixtures:fetch` (see README, \"Fixtures\").";
