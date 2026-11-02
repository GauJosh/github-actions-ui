// Fixture-mode GitHub for the emergency execution demo: serves examples/emergency-demo as the repository
// emergency-demo/release-pipeline (branch main) and examples/emergency-demo-shared-actions as demo-org/shared-actions
// (tag v1), through the read-only routes snapshot preparation uses. Blob and commit SHAs are computed like git's, so
// they change when the files change. Independent of the pinned fixture corpus.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Repo = { fullName: string; refs: string[]; files: Map<string, Buffer>; blobs: Map<string, Buffer>; commit: string; treeSha: string; tree: { path: string; size: number; sha: string; executable: boolean }[] };

const blobSha = (data: Buffer) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

/** git's tree ID for regular files: a synchronous twin of src/emergency/git-objects.ts gitTreeId (a test checks they agree). */
export function treeShaSync(entries: { path: string; sha: string; executable: boolean }[]): string {
  type Dir = { files: Map<string, { sha: string; executable: boolean }>; dirs: Map<string, Dir> };
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const e of entries) {
    const parts = e.path.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { files: new Map(), dirs: new Map() });
      d = d.dirs.get(p)!;
    }
    d.files.set(parts.at(-1)!, e);
  }
  const hash = (d: Dir): string => {
    const items = [
      ...[...d.files].map(([n, f]) => ({ key: n, bytes: Buffer.concat([Buffer.from(`${f.executable ? "100755" : "100644"} ${n}\0`), Buffer.from(f.sha, "hex")]) })),
      ...[...d.dirs].map(([n, sub]) => ({ key: `${n}/`, bytes: Buffer.concat([Buffer.from(`40000 ${n}\0`), Buffer.from(hash(sub), "hex")]) })),
    ].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const body = Buffer.concat(items.map((i) => i.bytes));
    return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
  };
  return hash(root);
}

function load(dir: string, fullName: string, refs: string[]): Repo {
  const files = new Map<string, Buffer>();
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) files.set(r, readFileSync(join(abs, e.name)));
    }
  };
  walk(dir, "");
  const tree = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, size: data.length, sha: blobSha(data), executable: path.endsWith(".sh") }));
  const blobs = new Map(tree.map((t) => [t.sha, files.get(t.path)!]));
  const commit = createHash("sha1").update(`${fullName}\n${tree.map((t) => `${t.path} ${t.sha}`).join("\n")}`).digest("hex");
  return { fullName, refs, files, blobs, commit, treeSha: treeShaSync(tree), tree };
}

export const EMERGENCY_DEMO_REPO = "emergency-demo/release-pipeline";

export function createEmergencyDemo(repoRoot: string) {
  let repos: Map<string, Repo> | undefined;
  const all = () =>
    (repos ??= new Map(
      [load(join(repoRoot, "examples/emergency-demo"), EMERGENCY_DEMO_REPO, ["main"]), load(join(repoRoot, "examples/emergency-demo-shared-actions"), "demo-org/shared-actions", ["v1", "main"])].map((r) => [
        r.fullName.toLowerCase(),
        r,
      ]),
    ));

  /** Answers `/api/repos/{owner}/{repo}/…` for the demo repositories; undefined for anything else. */
  return function handle(path: string, url: URL): { status: number; body: unknown } | undefined {
    const m = /^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return undefined;
    const repo = all().get(`${m[1]}/${m[2]}`.toLowerCase());
    if (!repo) return undefined;
    // Fresh reads, so edits to examples/ show up without restarting the dev server.
    repos = undefined;
    const rest = m[3] ?? "";
    const notFound = { status: 404, body: { message: "Not Found" } };
    const [owner, name] = repo.fullName.split("/") as [string, string];
    if (rest === "") return { status: 200, body: { full_name: repo.fullName, name, owner: { login: owner }, private: false, default_branch: repo.refs[0], description: "Emergency execution demo (fixture)" } };
    const resolve = (ref: string) => {
      const short = ref.replace(/^refs\/(?:heads|tags)\//, "");
      return short === repo.commit || repo.refs.includes(short) ? repo.commit : undefined;
    };
    let x = /^\/commits\/([^/]+)$/.exec(rest);
    if (x) {
      const sha = resolve(decodeURIComponent(x[1]!));
      return sha ? { status: 200, body: { sha, commit: { message: "Emergency demo pipeline" } } } : { status: 422, body: { message: "No commit found for SHA" } };
    }
    x = /^\/git\/trees\/([^/]+)$/.exec(rest);
    if (x) {
      if (resolve(x[1]!) !== repo.commit) return notFound;
      return { status: 200, body: { sha: repo.treeSha, truncated: false, tree: repo.tree.map((t) => ({ path: t.path, mode: t.executable ? "100755" : "100644", type: "blob", size: t.size, sha: t.sha })) } };
    }
    x = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (x) {
      return x[1] === repo.commit ? { status: 200, body: { sha: repo.commit, tree: { sha: repo.treeSha }, message: "Emergency demo pipeline" } } : notFound;
    }
    x = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (x) {
      const data = repo.blobs.get(x[1]!);
      return data ? { status: 200, body: { sha: x[1], size: data.length, encoding: "base64", content: data.toString("base64") } } : notFound;
    }
    x = /^\/contents\/(.+)$/.exec(rest);
    if (x) {
      if (resolve(url.searchParams.get("ref") ?? repo.refs[0]!) !== repo.commit) return notFound;
      const p = decodeURIComponent(x[1]!);
      const data = repo.files.get(p);
      return data ? { status: 200, body: { type: "file", encoding: "base64", path: p, name: p.split("/").at(-1), content: data.toString("base64") } } : notFound;
    }
    if (rest === "/actions/workflows") {
      const workflows = repo.tree
        .filter((t) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(t.path))
        .map((t, i) => ({ id: 7700 + i, name: /^name:\s*(.+)$/m.exec(repo.files.get(t.path)!.toString("utf8"))?.[1]?.trim() ?? t.path, path: t.path, state: "active" }));
      return { status: 200, body: { total_count: workflows.length, workflows } };
    }
    if (rest.startsWith("/actions/runs")) return { status: 200, body: { total_count: 0, workflow_runs: [] } };
    return notFound;
  };
}
