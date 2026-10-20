import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthProvider } from "../auth/pat-provider";
import { createGitHubClient, GitHubError } from "./client";
import { FixtureModeViolation, ReadOnlyViolation, createFixtureTransport, createLiveTransport, type ReadMethod } from "./transport";

const FAKE_TOKEN = "test-token-not-real-0001";
const auth: AuthProvider = {
  authorize: (h) => h.set("Authorization", `Bearer ${FAKE_TOKEN}`),
  describe: () => ({ kind: "pat", connected: true }),
  clear: () => {},
};

const seen: { method: string; url: string; authorization: string | null }[] = [];
const ref = { owner: "o", repo: "r", runId: 7 };
const server = setupServer(
  http.all("*", ({ request }) => {
    seen.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization") });
  }),
  http.get("https://api.github.com/repos/o/r/actions/runs/7", () => HttpResponse.json({ id: 7, display_title: "t" })),
  http.get("https://api.github.com/repos/o/r/actions/runs/7/jobs", ({ request }) =>
    new URL(request.url).searchParams.get("page") === "2"
      ? HttpResponse.json({ jobs: [{ id: 2 }] })
      : HttpResponse.json({ jobs: [{ id: 1 }] }, { headers: { Link: '<https://api.github.com/repos/o/r/actions/runs/7/jobs?page=2>; rel="next"' } }),
  ),
  http.get("https://api.github.com/repos/o/r/actions/runs/401", () => new HttpResponse(null, { status: 401 })),
  http.get("https://api.github.com/repos/o/r/actions/runs/403", () =>
    HttpResponse.json({ message: "Resource not accessible by personal access token" }, { status: 403 }),
  ),
  http.get("https://api.github.com/repos/o/r/actions/runs/429", () =>
    HttpResponse.json({ message: "rate" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } }),
  ),
  http.get("https://api.github.com/repos/o/r/actions/runs/404", () => new HttpResponse(null, { status: 404 })),
  http.get("http://localhost:5173/__fixtures/api/repos/o/r/actions/runs/7", () => HttpResponse.json({ id: 7 })),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  seen.length = 0;
  server.resetHandlers();
});
afterAll(() => server.close());

const live = createGitHubClient({ apiBase: "https://api.github.com", transport: createLiveTransport(auth) });

describe("live GitHub client", () => {
  it("sends the token to the API host and reads JSON", async () => {
    expect(await live.getRun(ref)).toMatchObject({ id: 7 });
    expect(seen[0]).toMatchObject({ method: "GET", authorization: `Bearer ${FAKE_TOKEN}` });
  });

  it("follows Link pagination for jobs", async () => {
    expect((await live.getJobs(ref)).map((j) => j.id)).toEqual([1, 2]);
  });

  it.each([
    [401, { kind: "auth-failed" }],
    [403, { kind: "permission", detail: "Resource not accessible by personal access token" }],
    [429, { kind: "rate-limited", resetAt: 1_700_000_000_000 }],
    [404, { kind: "not-found-or-no-permission" }],
  ])("maps HTTP %s to an explicit failure", async (runId, failure) => {
    const error = await live.getRun({ ...ref, runId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).failure).toEqual(failure);
  });
});

describe("unmocked requests", () => {
  it("are rejected by MSW (onUnhandledFrame: error) and never reach the network", async () => {
    await expect(fetch("https://api.github.com/repos/o/r/unmocked")).rejects.toThrow();
    await expect(live.getRun({ ...ref, runId: 999 })).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("transports are read-only and scoped", () => {
  it("refuses non-read methods before any request is made", async () => {
    const transport = createLiveTransport(auth);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(transport({ method: method as ReadMethod, url: "https://api.github.com/repos/o/r" })).rejects.toBeInstanceOf(ReadOnlyViolation);
    }
    expect(seen).toEqual([]);
  });

  it("never sends the token to a host other than the API", async () => {
    const transport = createLiveTransport(auth);
    await expect(transport({ method: "GET", url: "https://example.com/x" })).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(transport({ method: "GET", url: "http://api.github.com/x" })).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(seen).toEqual([]);
  });

  it("fixture mode reaches only the fixture server, without a token, and cannot fall back to GitHub", async () => {
    const base = "http://localhost:5173/__fixtures/api";
    const fixtures = createGitHubClient({ apiBase: base, transport: createFixtureTransport(base) });
    expect(await fixtures.getRun(ref)).toMatchObject({ id: 7 });
    expect(seen[0]!.authorization).toBeNull();
    const transport = createFixtureTransport(base);
    await expect(transport({ method: "GET", url: "https://api.github.com/repos/o/r/actions/runs/7" })).rejects.toBeInstanceOf(FixtureModeViolation);
    await expect(transport({ method: "GET", url: "http://localhost:5173/elsewhere" })).rejects.toBeInstanceOf(FixtureModeViolation);
    expect(seen).toHaveLength(1);
  });
});
