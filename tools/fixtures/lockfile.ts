// Fixture lockfile: pins gha-ui-fixtures to one immutable commit and records each file's size and SHA-256.
// Runs under Node's built-in type stripping, so only erasable TypeScript syntax is used here.

export type LockedFile = { path: string; bytes: number; sha256: string };
export type LockFile = { repo: string; commit: string; files: LockedFile[] };

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function assertCommitSha(value: unknown): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new FixtureError(
      `Fixture pin must be a full 40-character commit SHA, got ${JSON.stringify(value)}. Branch names and tags are not accepted.`,
    );
  }
  return value;
}

export function assertSafePath(path: unknown): string {
  if (
    typeof path !== "string" ||
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new FixtureError(`Unsafe fixture path in lockfile: ${JSON.stringify(path)}`);
  }
  return path;
}

export function parseLock(text: string): LockFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FixtureError("Fixture lockfile is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new FixtureError("Fixture lockfile must be a JSON object");
  const { repo, commit, files } = raw as Record<string, unknown>;
  if (typeof repo !== "string" || !REPO.test(repo)) throw new FixtureError(`Invalid repo in lockfile: ${JSON.stringify(repo)}`);
  assertCommitSha(commit);
  if (!Array.isArray(files) || files.length === 0) throw new FixtureError("Fixture lockfile lists no files");
  const seen = new Set<string>();
  const parsed = files.map((entry: unknown): LockedFile => {
    const { path, bytes, sha256 } = (entry ?? {}) as Record<string, unknown>;
    assertSafePath(path);
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
      throw new FixtureError(`Invalid size for ${String(path)} in lockfile`);
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new FixtureError(`Invalid SHA-256 for ${String(path)} in lockfile`);
    if (seen.has(path as string)) throw new FixtureError(`Duplicate path in lockfile: ${String(path)}`);
    seen.add(path as string);
    return { path: path as string, bytes, sha256 };
  });
  return { repo, commit: commit as string, files: parsed };
}

export function formatLock(lock: LockFile): string {
  return JSON.stringify(lock, null, 2) + "\n";
}
