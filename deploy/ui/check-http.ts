// HTTP checks for a running production server (deploy/ui/server.mjs, locally or in its container). Compares the
// headers actually served with tools/vite/security-headers.ts, so a stale or hand-edited header file fails.
//
//   node deploy/ui/check-http.ts http://127.0.0.1:8080 [/gha-ui/]
//
// Prints one line per failed check and exits 1 if any failed. Requests go only to the given origin.
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_CSP, COMMON_HEADERS, WORKER_CSP } from "../../tools/vite/security-headers.ts";
import { checkBasePath } from "./server.mjs";

type Got = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

/** A raw request: the path is sent exactly as given (fetch would normalise dot segments and encodings). */
function raw(origin: string, method: string, path: string): Promise<Got> {
  const u = new URL(origin);
  return new Promise((done, fail) => {
    const req = request({ host: u.hostname, port: u.port, method, path, headers: { connection: "close" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`${method} ${path}: no response within 10 s`)));
    req.on("error", fail);
    req.end();
  });
}

export async function checkStaticServer(origin: string, basePath = "/"): Promise<string[]> {
  const failures: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  /** Exactly one header with exactly this value (a duplicate arrives as an array or a joined string). */
  const header = (got: Got, name: string, value: string, where: string) => {
    const v = got.headers[name.toLowerCase()];
    expect(v === value, `${where}: ${name} is ${JSON.stringify(v)}, expected ${JSON.stringify(value)}`);
  };
  const common = (got: Got, where: string) => {
    for (const [name, value] of Object.entries(COMMON_HEADERS)) header(got, name, value, where);
  };

  const health = await raw(origin, "GET", "/healthz");
  expect(health.status === 200 && health.body.toString() === "ok\n", `/healthz: status ${health.status}`);
  common(health, "/healthz");

  const index = await raw(origin, "GET", basePath);
  expect(index.status === 200, `${basePath}: status ${index.status}`);
  header(index, "Content-Type", "text/html; charset=utf-8", basePath);
  header(index, "Content-Security-Policy", APP_CSP, basePath);
  header(index, "Cache-Control", "no-cache", basePath);
  common(index, basePath);
  const query = await raw(origin, "GET", `${basePath}?mode=fixtures`);
  expect(query.status === 200 && query.body.equals(index.body), `${basePath}?mode=fixtures: status ${query.status}`);
  const head = await raw(origin, "HEAD", basePath);
  expect(head.status === 200 && head.body.length === 0, `HEAD ${basePath}: status ${head.status}, ${head.body.length} body bytes`);
  header(head, "Content-Security-Policy", APP_CSP, `HEAD ${basePath}`);

  // The page's own assets, as the build references them (relative to the page).
  const html = index.body.toString();
  const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]!);
  expect(refs.some((r) => r.endsWith(".js")) && refs.some((r) => r.endsWith(".css")), `${basePath}: no relative script and stylesheet references`);
  expect(!/(?:src|href)="\//.test(html), `${basePath}: the page references a root-absolute URL`);
  let bundle = "";
  for (const ref of refs) {
    const got = await raw(origin, "GET", basePath + ref);
    expect(got.status === 200, `${ref}: status ${got.status}`);
    header(got, "Content-Type", ref.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", ref);
    header(got, "Cache-Control", "public, max-age=31536000, immutable", ref);
    header(got, "Content-Security-Policy", APP_CSP, ref);
    common(got, ref);
    if (ref.endsWith(".js")) bundle += got.body.toString();
  }

  // The log worker, found the way the browser finds it: named in the main chunk, next to it in assets/.
  const worker = /log-worker-[\w-]+\.js/.exec(bundle)?.[0];
  expect(!!worker, "main chunk: no log worker reference");
  if (worker) {
    const got = await raw(origin, "GET", `${basePath}assets/${worker}`);
    expect(got.status === 200, `${worker}: status ${got.status}`);
    header(got, "Content-Type", "text/javascript; charset=utf-8", worker);
    header(got, "Content-Security-Policy", WORKER_CSP, worker);
    common(got, worker);
  }

  // A production build: fixture mode is compiled out, and its explicit "unavailable" state is kept.
  expect(bundle.includes("Fixture mode is not available in this build"), "bundle: not a production build (no fixture-unavailable state)");
  expect(!bundle.includes("__fixtures"), "bundle: contains the fixture API path");
  expect(bundle.includes("https://api.github.com"), "bundle: no GitHub API host");

  const notFound = [
    `${basePath}no-such-page`,
    `${basePath}runs/acme/app/1`,
    `${basePath}__fixtures/api/repos/acme/app/actions/runs/1`,
    "/__fixtures/api/repos/acme/app/actions/runs/1",
    `${basePath}assets/`,
    `${basePath}assets/../index.html`,
    `${basePath}%2e%2e/%2e%2e/etc/passwd`,
    `${basePath}..%2f..%2fetc%2fpasswd`,
    `${basePath}assets/..%5c..%5cserver.mjs`,
    `${basePath}%69ndex.html`,
    `${basePath}/index.html`,
    `${basePath}../server.mjs`,
    "/server.mjs",
    "/security-headers.json",
    "/package.json",
    "/etc/passwd",
  ];
  for (const path of notFound) {
    const got = await raw(origin, "GET", path);
    expect(got.status === 404 || got.status === 400, `${path}: status ${got.status}, expected 404`);
    header(got, "Content-Security-Policy", APP_CSP, path);
  }

  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const got = await raw(origin, method, basePath);
    expect(got.status === 405 && got.headers["allow"] === "GET, HEAD", `${method} ${basePath}: status ${got.status}`);
  }

  if (basePath !== "/") {
    const bare = await raw(origin, "GET", basePath.slice(0, -1));
    expect(bare.status === 308 && bare.headers["location"] === basePath, `${basePath.slice(0, -1)}: status ${bare.status}, location ${String(bare.headers["location"])}`);
    const root = await raw(origin, "GET", "/");
    expect(root.status === 404, `/ outside the base path: status ${root.status}`);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin, basePath = "/"] = process.argv.slice(2);
  if (!origin) throw new Error("Usage: node deploy/ui/check-http.ts <origin> [base path]");
  // The server's own rule. Git Bash on Windows rewrites a bare "/" or "/gha-ui/" argument into a Windows path
  // unless MSYS_NO_PATHCONV=1 is set; this names the problem instead of failing on the request.
  checkBasePath(basePath);
  const failures = await checkStaticServer(origin, basePath);
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(failures.length ? `${failures.length} check(s) failed` : `All checks passed for ${origin}${basePath}`);
  process.exitCode = failures.length ? 1 : 0;
}
