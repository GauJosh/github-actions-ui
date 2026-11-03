// Security review M3: the executor's HTTP pipeline authenticates and size-limits a request before buffering its body.
// Driven with mock req/res against the real listener (the test environment forbids real sockets), so the gating,
// streaming limit and concurrency cap are exercised end to end — not a standalone size helper.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CSRF_HEADER, SESSION_COOKIE, type ApiRequest, type ApiResponse } from "../../deploy/emergency/executor/api.ts";
import { createRequestListener, type RequestLimits } from "../../deploy/emergency/executor/http.ts";

const PREFIX = "/api/emergency/";
const SESSION = "s".repeat(43);

type Req = EventEmitter & { method: string; url: string; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn>; feed: (chunks: string[], opts?: { end?: boolean }) => Promise<void> };
function mockReq(method: string, path: string, headers: Record<string, string> = {}): Req {
  const ee = new EventEmitter() as Req;
  ee.method = method;
  ee.url = PREFIX + path;
  ee.headers = headers;
  ee.destroy = vi.fn();
  ee.feed = async (chunks, opts = {}) => {
    for (const c of chunks) ee.emit("data", Buffer.from(c));
    if (opts.end !== false) ee.emit("end");
    await new Promise((r) => setImmediate(r)); // let the async end handler run
  };
  return ee;
}
const asReq = (r: Req) => r as unknown as IncomingMessage;
function mockRes() {
  const res = { statusCode: 0, headers: {} as Record<string, unknown>, body: "", ended: false } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = res as unknown as ServerResponse;
  r.writeHead = ((status: number, h: Record<string, unknown>) => {
    res.statusCode = status;
    res.headers = h;
    return r;
  }) as ServerResponse["writeHead"];
  r.end = ((b?: Buffer) => {
    res.body = b ? b.toString() : "";
    res.ended = true;
    return r;
  }) as ServerResponse["end"];
  return res as { statusCode: number; headers: Record<string, unknown>; body: string; ended: boolean } & { _res: ServerResponse };
}

function harness(opts: { session?: boolean; limits?: Partial<RequestLimits> } = {}) {
  const api = vi.fn(async (r: ApiRequest): Promise<ApiResponse> => ({ status: 200, body: { ok: true, bytes: r.body?.length ?? 0 } }));
  const staticHandler = vi.fn(() => ({ status: 200, headers: {}, body: "static" }));
  const listener = createRequestListener({ apiPrefix: PREFIX, staticHandler, api, hasSession: () => opts.session ?? true, apiHeaders: {}, limits: opts.limits });
  const call = async (req: Req, chunks: string[] = [], feed: { end?: boolean } = {}) => {
    const res = mockRes();
    listener(asReq(req), res as unknown as ServerResponse);
    await req.feed(chunks, feed);
    return res;
  };
  return { api, staticHandler, call };
}
const authed = (method: string, path: string, extra: Record<string, string> = {}) => mockReq(method, path, { [CSRF_HEADER]: "1", cookie: `${SESSION_COOKIE}=${SESSION}`, ...extra });

describe("executor HTTP pipeline (security review M3)", () => {
  it("rejects an oversized body by Content-Length without reading it, and destroys the request", async () => {
    const h = harness({ session: false, limits: { maxSmallBody: 1000 } });
    const req = mockReq("POST", "executions", { "content-length": "999999" });
    const res = await h.call(req, ['{"x":"'.padEnd(500, "a")], { end: false });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "Request body too large" });
    expect(h.api).not.toHaveBeenCalled();
    expect(req.destroy).toHaveBeenCalled();
  });

  it("enforces the limit while streaming when there is no Content-Length (chunked cannot bypass)", async () => {
    const h = harness({ limits: { maxSmallBody: 1000 } });
    const req = authed("POST", "executions");
    const res = await h.call(req, ["a".repeat(600), "b".repeat(600), "c".repeat(600)], { end: false });
    expect(res.statusCode).toBe(413);
    expect(h.api).not.toHaveBeenCalled();
    expect(req.destroy).toHaveBeenCalled();
  });

  it("rejects missing CSRF header, a bearer token, and no session before buffering", async () => {
    const h = harness({ session: false });
    const noCsrf = await h.call(mockReq("POST", "executions", { cookie: `${SESSION_COOKIE}=${SESSION}` }), ['{"a":1}']);
    expect(noCsrf.statusCode).toBe(403);
    const bearer = await h.call(mockReq("GET", "snapshots", { [CSRF_HEADER]: "1", authorization: "Bearer x" }), []);
    expect(bearer.statusCode).toBe(401);
    const noSession = await h.call(mockReq("GET", "snapshots", { [CSRF_HEADER]: "1" }), []);
    expect(noSession.statusCode).toBe(401);
    expect(h.api).not.toHaveBeenCalled();
  });

  it("lets a valid authenticated request through with its buffered body", async () => {
    const h = harness({ session: true });
    const res = await h.call(authed("POST", "executions"), ['{"snapshotId":"x"}']);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, bytes: 18 });
    expect(h.api).toHaveBeenCalledOnce();
    expect(h.api.mock.calls[0]![0].path).toBe("executions");
  });

  it("allows a large body only on POST snapshots, up to the upload limit", async () => {
    const h = harness({ session: true, limits: { maxUploadBody: 5000, maxSmallBody: 100 } });
    const ok = await h.call(authed("POST", "snapshots"), ["x".repeat(4000)]);
    expect(ok.statusCode).toBe(200);
    // The same size on another route is over its small limit.
    const tooBig = await h.call(authed("POST", "executions"), ["x".repeat(4000)], { end: false });
    expect(tooBig.statusCode).toBe(413);
  });

  it("bounds concurrent snapshot uploads, returning 503 before buffering beyond the cap", async () => {
    const h = harness({ session: true, limits: { maxConcurrentUploads: 1 } });
    // First upload starts and stays in progress (no end emitted yet).
    const first = authed("POST", "snapshots");
    void h.call(first, [], { end: false }); // registers handlers, increments activeUploads
    const second = await h.call(authed("POST", "snapshots"), [], { end: false });
    expect(second.statusCode).toBe(503);
    // Finishing the first frees the slot for a later upload.
    first.emit("end");
    await new Promise((r) => setImmediate(r));
    const third = await h.call(authed("POST", "snapshots"), ["{}"]);
    expect(third.statusCode).toBe(200);
  });

  it("serves non-API paths through the static handler untouched", async () => {
    const api = vi.fn();
    const res = mockRes();
    const req = mockReq("GET", "");
    req.url = "/index.html";
    createRequestListener({ apiPrefix: PREFIX, staticHandler: () => ({ status: 200, headers: {}, body: "home" }), api, hasSession: () => true, apiHeaders: {} })(asReq(req), res as unknown as ServerResponse);
    expect(res.body).toBe("home");
    expect(api).not.toHaveBeenCalled();
  });

  it("rejection responses are generic and never echo the request body", async () => {
    const h = harness({ session: false, limits: { maxSmallBody: 10 } });
    const res = await h.call(mockReq("POST", "executions", { [CSRF_HEADER]: "1" }), ["SENSITIVE-BODY-CONTENT-THAT-IS-LONG"], { end: false });
    expect([401, 413]).toContain(res.statusCode);
    expect(res.body).not.toContain("SENSITIVE");
    expect(Object.keys(JSON.parse(res.body))).toEqual(["error"]);
  });
});
