// The executor's HTTP request pipeline (security review M3). The API handler (api.ts) authenticates and authorizes a
// request, but it only sees an already-buffered body. This layer runs first and refuses a request before reading or
// buffering its body whenever the handler would reject it anyway, so an unauthenticated or oversized request can't
// make the executor allocate memory:
// - a Content-Length over the route's limit is refused at once (413), and the body is never read;
// - the route's limit is enforced while the body streams: as soon as it is exceeded the request is refused (413) and
//   the socket destroyed, so a chunked upload with no Content-Length can't keep sending;
// - routes that need the page's CSRF header, or a valid session, are refused (403 / 401) before any body is read —
//   the same gate api.ts applies, mirrored early so the body is never buffered;
// - at most a configured number of large (snapshot) uploads buffer at once; beyond that a 503 is returned before
//   buffering, so many concurrent uploads can't exhaust memory.
// Rejection responses are generic and never echo the body. api.ts stays the authority: it checks everything again.
import type { IncomingMessage, ServerResponse } from "node:http";
import { cookies, CSRF_HEADER, MAX_SMALL_BODY, MAX_SNAPSHOT_BODY, SESSION_COOKIE, type ApiRequest, type ApiResponse } from "./api.ts";

export type RequestLimits = {
  /** Largest body for a snapshot upload (POST snapshots). Default MAX_SNAPSHOT_BODY. */
  maxUploadBody: number;
  /** Largest body for every other API route. Default MAX_SMALL_BODY. */
  maxSmallBody: number;
  /** How many snapshot uploads may buffer at once before further ones get 503. */
  maxConcurrentUploads: number;
};

export const DEFAULT_LIMITS: RequestLimits = { maxUploadBody: MAX_SNAPSHOT_BODY, maxSmallBody: MAX_SMALL_BODY, maxConcurrentUploads: 2 };

// Routes api.ts lets through without the CSRF header, and without a session (it authenticates break-glass by body).
const NO_CSRF = new Set(["health", "auth/login", "auth/callback"]);
const NO_SESSION = new Set(["health", "auth/login", "auth/callback", "auth/break-glass"]);
const routeKey = (path: string) => path.replace(/\/+$/, "");

/** The body-size cap for a route, before anything is read. Only POST snapshots may be large. */
export function bodyLimit(method: string, path: string, limits: RequestLimits): number {
  return method === "POST" && routeKey(path) === "snapshots" ? limits.maxUploadBody : limits.maxSmallBody;
}

export type ListenerDeps = {
  apiPrefix: string;
  staticHandler: (method: string | undefined, url: string) => { status: number; headers: Record<string, string | string[]>; body?: string | Buffer };
  api: (r: ApiRequest) => Promise<ApiResponse>;
  /** Whether a session cookie currently maps to a live principal; api.ts remains the authority. */
  hasSession: (token: string | undefined) => boolean;
  apiHeaders: Record<string, string | string[]>;
  limits?: Partial<RequestLimits>;
};

export function createRequestListener(deps: ListenerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  let activeUploads = 0;

  return (req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0]!;
    if (!path.startsWith(deps.apiPrefix)) {
      const r = deps.staticHandler(req.method, url);
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }
    const method = req.method ?? "GET";
    const route = routeKey(path.slice(deps.apiPrefix.length));
    const send = (status: number, body: unknown, extra: Record<string, string | string[]> = {}) => {
      const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { ...deps.apiHeaders, ...extra, "Content-Length": String(data.length) });
      res.end(data);
    };
    // Refuse and stop the upload: nothing more is read into memory.
    const refuse = (status: number, error: string) => {
      send(status, { error });
      req.destroy();
    };

    const limit = bodyLimit(method, route, limits);
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > limit) return refuse(413, "Request body too large");
    // Mirror api.ts's gate before buffering (it checks all of this again).
    if (!NO_CSRF.has(route) && req.headers[CSRF_HEADER] !== "1") return refuse(403, `Missing the ${CSRF_HEADER} header`);
    if (!NO_CSRF.has(route) && req.headers.authorization) return refuse(401, "The shared operator token no longer authorizes API calls (security review H2): sign in, or use a break-glass account");
    if (!NO_SESSION.has(route) && !deps.hasSession(cookies(req.headers.cookie as string | undefined)[SESSION_COOKIE])) return refuse(401, "Sign-in required");

    const isUpload = method === "POST" && route === "snapshots";
    if (isUpload && activeUploads >= limits.maxConcurrentUploads) return refuse(503, "The executor is busy storing other snapshots; retry shortly");
    if (isUpload) activeUploads++;
    let released = false;
    const release = () => {
      if (isUpload && !released) {
        released = true;
        activeUploads--;
      }
    };

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        release();
        refuse(413, "Request body too large");
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => {
      done = true;
      release();
    });
    req.on("end", async () => {
      if (done) return;
      done = true;
      const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : v);
      const request: ApiRequest = {
        method,
        path: path.slice(deps.apiPrefix.length),
        query: new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : ""),
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), single(v)])),
        body: Buffer.concat(chunks),
      };
      try {
        const r = await deps.api(request);
        send(r.status, r.body, r.headers);
      } finally {
        release();
      }
    });
  };
}
