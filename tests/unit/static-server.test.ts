// The production static server's request policy (deploy/ui/server.mjs), checked without sockets: the handler is a
// pure function of method and raw request target. HTTP-level checks against a running server, locally and in the
// container, are in tests/e2e/static-server.spec.ts and deploy/ui/check-http.ts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { checkBasePath, createHandler, loadHeaders, loadSite } from "../../deploy/ui/server.mjs";
import { serverHeaders } from "../../deploy/ui/write-security-headers.ts";
import { APP_CSP, COMMON_HEADERS, WORKER_CSP, isWorkerScript } from "../../tools/vite/security-headers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "gha-ui-static-"));
  dirs.push(d);
  return d;
};

/** A small site shaped like a Vite build, with a secret beside it that must never be served. */
function site() {
  const outer = temp();
  writeFileSync(join(outer, "secret.txt"), "outside the static root");
  const root = join(outer, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), '<script type="module" src="./assets/index-AbCd1234.js"></script>');
  writeFileSync(join(root, "assets", "index-AbCd1234.js"), "new URL(`log-worker-Zx_9-8Yw.js`, import.meta.url)");
  writeFileSync(join(root, "assets", "log-worker-Zx_9-8Yw.js"), "self.onmessage = () => {};");
  writeFileSync(join(root, "assets", "index-Dp8af_7p.css"), "body{}");
  writeFileSync(join(root, "assets", "showcase-dark-CrKoCAAT.png"), Buffer.from([0x89, 0x50]));
  writeFileSync(join(root, "assets", "font-Qw3rTy12.woff2"), Buffer.from([0x77]));
  writeFileSync(join(root, "robots.txt"), "User-agent: *");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, "notes.unknownext"), "x");
  try {
    symlinkSync(join(outer, "secret.txt"), join(root, "linked.txt"));
  } catch {
    // Symlinks may need privileges (Windows): the skip-symlinks rule is then not exercised here.
  }
  return root;
}

const headers = serverHeaders();

describe("static server: request policy", () => {
  const handle = createHandler({ site: loadSite(site()), headers });

  it("serves the page and its assets with the app CSP, the common headers, types and cache rules", () => {
    const page = handle("GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers).toMatchObject({
      "Content-Security-Policy": APP_CSP,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ...COMMON_HEADERS,
    });
    expect(handle("GET", "/index.html").body).toEqual(page.body);
    expect(handle("GET", "/?mode=fixtures#x").body).toEqual(page.body);

    const types: [string, string][] = [
      ["/assets/index-AbCd1234.js", "text/javascript; charset=utf-8"],
      ["/assets/index-Dp8af_7p.css", "text/css; charset=utf-8"],
      ["/assets/showcase-dark-CrKoCAAT.png", "image/png"],
      ["/assets/font-Qw3rTy12.woff2", "font/woff2"],
    ];
    for (const [path, type] of types) {
      const r = handle("GET", path);
      expect(r.status, path).toBe(200);
      expect(r.headers["Content-Type"]).toBe(type);
      expect(r.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
      expect(r.headers["Content-Security-Policy"]).toBe(APP_CSP);
    }
    // Not hashed, so not immutable.
    expect(handle("GET", "/robots.txt").headers["Cache-Control"]).toBe("no-cache");
  });

  it("gives the log worker script, and only it, the worker CSP", () => {
    const worker = handle("GET", "/assets/log-worker-Zx_9-8Yw.js");
    expect(worker.status).toBe(200);
    expect(worker.headers["Content-Security-Policy"]).toBe(WORKER_CSP);
    expect(worker.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(handle("GET", "/assets/index-AbCd1234.js").headers["Content-Security-Policy"]).toBe(APP_CSP);
    // The same rule as vite preview's.
    expect(isWorkerScript("/assets/log-worker-Zx_9-8Yw.js")).toBe(true);
  });

  it("each header is sent once, with no conflicting duplicates", () => {
    const names = Object.keys(handle("GET", "/").headers).map((n) => n.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("HEAD has the headers and no body; other methods are refused", () => {
    const head = handle("HEAD", "/");
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers["Content-Length"]).toBe(String(handle("GET", "/").body.length));
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", undefined]) {
      const r = handle(method, "/");
      expect(r.status, String(method)).toBe(405);
      expect(r.headers["Allow"]).toBe("GET, HEAD");
      expect(r.headers["Content-Security-Policy"]).toBe(APP_CSP);
    }
  });

  it("answers /healthz without touching the site", () => {
    const r = handle("GET", "/healthz");
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("ok\n");
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("serves nothing outside the build: no fallback page, fixtures, traversal, encodings, dotfiles or symlinks", () => {
    const refused = [
      "/runs/acme/app/1",
      "/no-such-page",
      "/assets",
      "/assets/",
      "/__fixtures/api/repos/acme/app/actions/runs/1",
      "/../secret.txt",
      "/assets/../index.html",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/assets%2findex-AbCd1234.js",
      "/%69ndex.html",
      "/INDEX.HTML",
      "//index.html",
      "/./index.html",
      "/index.html/",
      "/index.html%00.png",
      "/\\..\\secret.txt",
      "/.env",
      "/notes.unknownext",
      "/linked.txt",
      "/secret.txt",
    ];
    for (const path of refused) {
      const r = handle("GET", path);
      expect(r.status, path).toBe(404);
      expect(r.body.toString(), path).toBe("Not found\n");
      expect(r.headers["Content-Security-Policy"]).toBe(APP_CSP);
    }
    // Not an origin-form request target.
    for (const target of ["index.html", "http://evil.example/", "*", "", undefined]) expect(handle("GET", target).status, String(target)).toBe(400);
  });
});

describe("static server: under a path prefix", () => {
  const handle = createHandler({ site: loadSite(site()), headers, basePath: "/gha-ui/" });

  it("serves the same files under the prefix, and nothing outside it except /healthz", () => {
    expect(handle("GET", "/gha-ui/").status).toBe(200);
    expect(handle("GET", "/gha-ui/assets/log-worker-Zx_9-8Yw.js").headers["Content-Security-Policy"]).toBe(WORKER_CSP);
    expect(handle("GET", "/gha-ui/assets/index-AbCd1234.js").headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(handle("GET", "/healthz").status).toBe(200);
    for (const path of ["/", "/index.html", "/assets/index-AbCd1234.js", "/gha-uix/", "/gha-ui/../index.html", "/gha-ui/gha-ui/"]) expect(handle("GET", path).status, path).toBe(404);
  });

  it("redirects the bare prefix to the prefix with its slash, keeping the query", () => {
    const r = handle("GET", "/gha-ui");
    expect(r.status).toBe(308);
    expect(r.headers["Location"]).toBe("/gha-ui/");
    expect(handle("GET", "/gha-ui?mode=fixtures").headers["Location"]).toBe("/gha-ui/?mode=fixtures");
  });

  it("accepts only a plain absolute prefix ending in a slash", () => {
    for (const ok of ["/", "/gha-ui/", "/tools/gha-ui/", "/a.b_c~d/"]) expect(checkBasePath(ok)).toBe(ok);
    for (const bad of ["", "gha-ui/", "/gha-ui", "/../", "/./", "/a/../b/", "//", "/gha ui/", "/%2e%2e/", "/gha-ui/?x/"]) expect(() => checkBasePath(bad), bad).toThrow();
  });
});

describe("static server: configuration", () => {
  it("the generated header file is the single source's values, exactly", () => {
    const file = join(temp(), "headers.json");
    writeFileSync(file, JSON.stringify(serverHeaders()));
    expect(loadHeaders(file)).toEqual({ app: APP_CSP, worker: WORKER_CSP, common: { ...COMMON_HEADERS } });
  });

  it("refuses a missing, empty or header-splitting value", () => {
    const file = join(temp(), "headers.json");
    for (const bad of [{}, { ...headers, worker: "" }, { ...headers, app: "default-src 'self'\r\nSet-Cookie: x=1" }, { ...headers, common: { "X-A": 1 } }]) {
      writeFileSync(file, JSON.stringify(bad));
      expect(() => loadHeaders(file)).toThrow(/Invalid security headers/);
    }
  });

  it("a site without index.html is refused at startup", () => {
    expect(() => loadSite(temp())).toThrow(/No index.html/);
  });
});

describe("production build: relative asset and worker URLs", () => {
  it("references every asset and the log worker relative to the page, so one build serves at any prefix", async () => {
    const saved = process.env.GHA_UI_FIXTURES;
    delete process.env.GHA_UI_FIXTURES;
    const outDir = temp();
    try {
      await build({ configFile: "vite.config.ts", logLevel: "silent", build: { outDir, emptyOutDir: true } });
    } finally {
      if (saved !== undefined) process.env.GHA_UI_FIXTURES = saved;
    }
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref, ref).toMatch(/^\.\/assets\/[\w.-]+$/);

    const served = loadSite(outDir);
    const main = [...served.keys()].find((k) => /^assets\/index-[\w-]+\.js$/.test(k))!;
    const code = served.get(main)!.body.toString();
    // The worker is resolved against the main chunk's own URL (both in assets/), never from the site root.
    const worker = /new URL\(`(log-worker-[\w-]+\.js)`,import\.meta\.url\)/.exec(code)?.[1];
    expect(worker).toBeDefined();
    expect(code).not.toMatch(/["'`]\/assets\//);
    // The server recognises that file as the worker, as vite preview does.
    const handle = createHandler({ site: served, headers, basePath: "/gha-ui/" });
    expect(isWorkerScript(`/assets/${worker}`)).toBe(true);
    expect(handle("GET", `/gha-ui/assets/${worker}`).headers["Content-Security-Policy"]).toBe(WORKER_CSP);
    for (const ref of refs) expect(handle("GET", `/gha-ui/${ref.slice(2)}`).status, ref).toBe(200);
  }, 120_000);
});
