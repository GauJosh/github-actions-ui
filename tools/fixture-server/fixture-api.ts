// Fixture-mode API: serves the pinned gha-ui-fixtures corpus at /__fixtures/api with GitHub-shaped
// routes, HEAD and explicit byte ranges. Read-only, local only, and never contacts GitHub.
// It refuses to serve anything if the prepared fixtures do not match the lockfile.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { NOT_PREPARED, fixtureDir, verifyFixtures } from "../fixtures/fixtures.ts";
import { parseLock } from "../fixtures/lockfile.ts";
import { SYNTHETIC_LARGE, syntheticJobs, syntheticLog, syntheticRun } from "./synthetic.ts";

export const FIXTURE_PREFIX = "/__fixtures";

type RunEntry = { owner: string; repo: string; runId: number; dir: string };
type Corpus = { runs: Map<number, RunEntry>; logs: Map<number, { path: string | null; status: string }>; index: unknown[] };

function loadCorpus(root: string): Corpus {
  const runs = new Map<number, RunEntry>();
  const logs = new Map<number, { path: string | null; status: string }>();
  const index: unknown[] = [];
  for (const ownerRepo of readdirSync(root)) {
    const [owner, repo] = ownerRepo.split("__") as [string, string];
    for (const id of readdirSync(join(root, ownerRepo))) {
      const dir = join(root, ownerRepo, id);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        conclusion: string;
        workflow: string;
        logs: Record<string, string>;
      };
      runs.set(Number(id), { owner, repo, runId: Number(id), dir });
      for (const [jobId, status] of Object.entries(manifest.logs)) {
        const path = join(dir, "logs", `${jobId}.log.gz`);
        logs.set(Number(jobId), { path: existsSync(path) ? path : null, status });
      }
      index.push({ owner, repo, runId: Number(id), title: manifest.workflow, conclusion: manifest.conclusion });
    }
  }
  return { runs, logs, index };
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(text);
};

/** Parses `bytes=a-b` (the only form the client sends). Returns null for anything else. */
function parseRange(header: string | undefined, size: number): [number, number] | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (!m) return "invalid";
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), size - 1);
  return start <= end ? [start, end] : "invalid";
}

/** Streams in 64 KiB chunks so the client sees a progressive download, as from the real log host. */
function streamBytes(res: ServerResponse, read: (start: number, end: number) => Buffer, start: number, end: number): void {
  let pos = start;
  const pump = () => {
    while (pos <= end) {
      const next = Math.min(end + 1, pos + 64 * 1024);
      const ok = res.write(read(pos, next));
      pos = next;
      if (!ok) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  pump();
}

export function createFixtureMiddleware(options: { repoRoot: string; lockPath: string }) {
  let state: { corpus: Corpus } | { error: string } | null = null;
  const decompressed = new Map<number, Buffer>();

  const init = () => {
    if (state) return state;
    try {
      const lock = parseLock(readFileSync(options.lockPath, "utf8"));
      const outRoot = join(options.repoRoot, ".fixtures");
      const problems = verifyFixtures(lock, outRoot);
      state = problems.length
        ? { error: `${NOT_PREPARED} (${problems.length} problem(s), first: ${problems[0]})` }
        : { corpus: loadCorpus(join(fixtureDir(outRoot, lock), "fixtures")) };
    } catch (error) {
      state = { error: `${NOT_PREPARED} (${(error as Error).message})` };
    }
    return state;
  };

  const logBytes = (jobId: number, path: string): Buffer => {
    let data = decompressed.get(jobId);
    if (!data) {
      data = gunzipSync(readFileSync(path));
      if (decompressed.size >= 3) decompressed.delete(decompressed.keys().next().value!);
      decompressed.set(jobId, data);
    }
    return data;
  };

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    if (!url.pathname.startsWith(FIXTURE_PREFIX + "/")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { message: "Fixture API is read-only" });

    const ready = init();
    if ("error" in ready) return send(res, 503, { message: ready.error });
    const { corpus } = ready;
    const path = url.pathname.slice(FIXTURE_PREFIX.length);

    if (path === "/index") return send(res, 200, [syntheticRun.indexEntry, ...corpus.index]);

    let m = /^\/api\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(\/jobs)?$/.exec(path);
    if (m) {
      const runId = Number(m[3]);
      if (runId === SYNTHETIC_LARGE.runId) return send(res, 200, m[4] ? syntheticJobs() : syntheticRun.run);
      const run = corpus.runs.get(runId);
      if (!run || run.owner !== m[1] || run.repo !== m[2]) return send(res, 404, { message: "Not Found" });
      if (!m[4]) return send(res, 200, readFileSync(join(run.dir, "run.json"), "utf8"));
      const attempts = readdirSync(join(run.dir, "attempts")).map(Number).sort((a, b) => b - a);
      return send(res, 200, readFileSync(join(run.dir, "attempts", String(attempts[0]), "jobs.json"), "utf8"));
    }

    m = /^\/api\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (m) {
      const jobId = Number(m[3]);
      let size: number;
      let read: (start: number, end: number) => Buffer;
      if (jobId === SYNTHETIC_LARGE.jobId) {
        size = SYNTHETIC_LARGE.bytes;
        read = syntheticLog;
      } else {
        const entry = corpus.logs.get(jobId);
        if (!entry) return send(res, 404, { message: "Not Found" });
        if (!entry.path) return send(res, 404, { message: `Log not captured (${entry.status})` });
        const data = logBytes(jobId, entry.path);
        size = data.byteLength;
        read = (start, end) => data.subarray(start, end);
      }
      const range = parseRange(req.headers.range, size);
      if (range === "invalid") return send(res, 416, { message: "Range Not Satisfiable" }, { "Content-Range": `bytes */${size}` });
      const [start, end] = range ?? [0, size - 1];
      res.writeHead(range ? 206 : 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (req.method === "HEAD" || size === 0) return void res.end();
      return streamBytes(res, read, start, end);
    }

    return send(res, 404, { message: "Not Found" });
  };
}
