// The API → log-host redirect through the real live transport (Node fetch + MSW): the token is not sent to
// the log host, diagnostics keep only its host, and nothing from the signed URL is surfaced.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthProvider } from "../../auth/pat-provider";
import { createGitHubClient } from "../../github/client";
import { createLiveTransport } from "../../github/transport";
import { LogLoader } from "./loader";
import { inProcessWorker, sampleLog } from "./test-support";

const FAKE_TOKEN = "unit-fake-token-not-real";
const MARKER = "SIGMARKERUNIT";
const BLOB = "productionresultssa7.blob.core.windows.net";
const LOG = sampleLog(600_000);
const blobAuth: (string | null)[] = [];

const server = setupServer(
  http.all("https://api.github.com/repos/o/r/actions/jobs/9/logs", () =>
    new HttpResponse(null, { status: 302, headers: { Location: `https://${BLOB}/logs/9.txt?sv=2025&sig=${MARKER}` } }),
  ),
  http.all(`https://${BLOB}/logs/9.txt`, ({ request }) => {
    blobAuth.push(request.headers.get("authorization"));
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
    if (request.method === "HEAD") return new HttpResponse(null, { status: 200, headers: { "Content-Length": String(LOG.length) } });
    if (!range) return new HttpResponse(LOG, { status: 200 });
    const [start, end] = [Number(range[1]), Math.min(Number(range[2]), LOG.length - 1)];
    return new HttpResponse(LOG.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${LOG.length}` } });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

describe("log redirect through the live transport", () => {
  it("drops the token on the cross-origin redirect and records only the log host", async () => {
    const auth: AuthProvider = { authorize: (h) => h.set("Authorization", `Bearer ${FAKE_TOKEN}`), describe: () => ({ kind: "pat", connected: true }), clear: () => {} };
    const client = createGitHubClient({ apiBase: "https://api.github.com", transport: createLiveTransport(auth) });
    const ref = { owner: "o", repo: "r", runId: 1, jobId: 9 };
    const loader = new LogLoader({
      request: (method, range, signal) => client.requestJobLog(ref, method, range, signal),
      apiHost: client.apiHost,
      createWorker: () => inProcessWorker(),
      sleep: async () => {},
      limits: { tailBytes: 64 * 1024 },
    });
    await loader.start();

    expect(loader.snapshot.status).toBe("complete");
    expect(blobAuth.length).toBeGreaterThanOrEqual(3);
    expect(blobAuth.every((a) => a === null)).toBe(true);
    expect(loader.events.filter((e) => e.host).every((e) => e.host === BLOB)).toBe(true);
    const surfaced = JSON.stringify({ events: loader.events, snapshot: loader.snapshot });
    expect(surfaced).not.toContain(MARKER);
    expect(surfaced).not.toContain("sig=");
    expect(surfaced).not.toContain(FAKE_TOKEN);
  });
});
