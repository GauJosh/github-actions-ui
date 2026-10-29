// Production static server for the built UI (deploy/ui/Dockerfile). Node built-ins only: it serves a fixed set of
// files and a health check, which needs no framework.
//
// - The build is read into memory at startup, and a request is answered only when its path, exactly as sent (no
//   decoding, no normalisation), names one of those files. No request path ever reaches the filesystem, so
//   traversal and encoding tricks have nothing to resolve against.
// - The security headers come from security-headers.json, generated at image build time from
//   tools/vite/security-headers.ts (deploy/ui/write-security-headers.ts): the log worker script gets the worker
//   CSP, every other response the app CSP.
// - GET and HEAD only. Routes live in the URL hash, so there is no fallback page: unknown paths are 404.
// - The build references its assets relative to the page (vite.config.ts), so it serves from "/" or under a path
//   prefix (GHA_UI_BASE_PATH, e.g. "/gha-ui/"). /healthz answers at the root either way, without contacting GitHub.
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Vite's hashed output (`assets/name-[hash8].ext`): its content never changes under that name. */
const HASHED = /^assets\/[\w.-]+-[\w-]{8}\.[a-z0-9]+$/;
/** The log worker script (tools/vite/security-headers.ts `isWorkerScript`, relative to the site root). */
const WORKER = /^assets\/log-worker-[\w-]+\.js$/;
const SEGMENT = /^[\w-][\w.-]*$/;
const BASE_PATH = /^\/(?:[\w~-][\w.~-]*\/)*$/;

/**
 * Reads the build into memory, keyed by its path relative to `root` ("index.html", "assets/x-abc.js"). Only regular
 * files with a known type and a plain name are kept: dotfiles, symlinks and other names are left out.
 */
export function loadSite(root) {
  const site = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!SEGMENT.test(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${path}/`);
      else if (entry.isFile() && TYPES[extname(entry.name).toLowerCase()]) {
        site.set(path, { body: readFileSync(join(dir, entry.name)), type: TYPES[extname(entry.name).toLowerCase()] });
      }
    }
  };
  walk(root, "");
  if (!site.has("index.html")) throw new Error(`No index.html in ${root}`);
  return site;
}

/** Reads and checks the generated header file: `{ app, worker, common: { name: value } }`. */
export function loadHeaders(file) {
  const h = JSON.parse(readFileSync(file, "utf8"));
  const ok = (v) => typeof v === "string" && v.length > 0 && !/[\r\n]/.test(v);
  if (!ok(h?.app) || !ok(h?.worker) || typeof h.common !== "object" || !Object.entries(h.common).every(([k, v]) => ok(k) && ok(v))) {
    throw new Error(`Invalid security headers in ${file}`);
  }
  return { app: h.app, worker: h.worker, common: { ...h.common } };
}

export function checkBasePath(basePath) {
  if (!BASE_PATH.test(basePath) || basePath.split("/").some((s) => s === "." || s === "..")) {
    throw new Error(`Invalid base path ${JSON.stringify(basePath)}: use "/" or a prefix such as "/gha-ui/"`);
  }
  return basePath;
}

const text = (body) => ({ body: Buffer.from(body), type: "text/plain; charset=utf-8" });

/**
 * The whole request policy as a pure function of the method and the raw request target.
 * Returns `{ status, headers, body }`; `body` is empty for HEAD.
 */
export function createHandler({ site, headers, basePath = "/" }) {
  checkBasePath(basePath);
  return (method, rawUrl) => {
    const respond = (status, file, extra = {}) => ({
      status,
      headers: {
        ...headers.common,
        "Content-Security-Policy": extra.csp ?? headers.app,
        "Content-Type": file.type,
        "Content-Length": String(file.body.length),
        "Cache-Control": extra.cache ?? "no-store",
        ...extra.headers,
      },
      body: method === "HEAD" ? Buffer.alloc(0) : file.body,
    });
    if (method !== "GET" && method !== "HEAD") return respond(405, text("Method not allowed\n"), { headers: { Allow: "GET, HEAD" } });
    if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return respond(400, text("Bad request\n"));
    const q = rawUrl.indexOf("?");
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
    if (path === "/healthz") return respond(200, text("ok\n"));
    if (basePath !== "/" && path === basePath.slice(0, -1)) {
      return respond(308, text("Permanent redirect\n"), { headers: { Location: basePath + (q === -1 ? "" : rawUrl.slice(q)) } });
    }
    if (!path.startsWith(basePath)) return respond(404, text("Not found\n"));
    const rel = path.slice(basePath.length) || "index.html";
    const file = site.get(rel);
    if (!file) return respond(404, text("Not found\n"));
    return respond(200, file, {
      csp: WORKER.test(rel) ? headers.worker : headers.app,
      cache: HASHED.test(rel) ? "public, max-age=31536000, immutable" : "no-cache",
    });
  };
}

export function startServer({ site, headers, basePath = "/", port = 8080, host }) {
  const handle = createHandler({ site, headers, basePath });
  const server = createServer((req, res) => {
    let r;
    try {
      r = handle(req.method, req.url);
    } catch {
      const body = Buffer.from("Internal error\n");
      const type = "text/plain; charset=utf-8";
      r = { status: 500, headers: { ...headers.common, "Content-Security-Policy": headers.app, "Content-Type": type, "Content-Length": String(body.length), "Cache-Control": "no-store" }, body };
    }
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListening(server));
  });
}

/** PORT, default 8080; 0 picks a free port (tests), and the startup line reports it. */
function envPort(value) {
  const port = Number(value ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT ${JSON.stringify(value)}`);
  return port;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = process.env.GHA_UI_STATIC_ROOT ?? join(here, "dist");
  const basePath = checkBasePath(process.env.GHA_UI_BASE_PATH ?? "/");
  const site = loadSite(root);
  const headers = loadHeaders(process.env.GHA_UI_HEADERS_FILE ?? join(here, "security-headers.json"));
  const server = await startServer({ site, headers, basePath, port: envPort(process.env.PORT) });
  const { port } = server.address();
  console.log(`gha-ui: serving ${site.size} files under ${basePath} on port ${port}`);
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
