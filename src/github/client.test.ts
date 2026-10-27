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
const WORKFLOW_TEXT = "name: CI ✓\njobs: {}\n";
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
  http.get("https://api.github.com/repos/o/r/actions/runs/7/attempts/1", () => HttpResponse.json({ id: 7, run_attempt: 1 })),
  http.get("https://api.github.com/repos/o/r/actions/runs/7/attempts/1/jobs", ({ request }) =>
    new URL(request.url).searchParams.get("page") === "2"
      ? HttpResponse.json({ jobs: [{ id: 12, run_attempt: 1 }] })
      : HttpResponse.json({ jobs: [{ id: 11, run_attempt: 1 }] }, { headers: { Link: '<https://api.github.com/repos/o/r/actions/runs/7/attempts/1/jobs?page=2>; rel="next"' } }),
  ),
  // Attempt 2 lists a job GitHub reports as run in attempt 1 (carried over by a partial re-run).
  http.get("https://api.github.com/repos/o/r/actions/runs/7/attempts/2/jobs", () => HttpResponse.json({ jobs: [{ id: 11, run_attempt: 1 }, { id: 21, run_attempt: 2 }] })),
  http.get("https://api.github.com/repos/o/r/actions/runs/7/attempts/9",() => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
  http.get("https://api.github.com/search/repositories", () => HttpResponse.json({ total_count: 1, incomplete_results: false, items: [{ full_name: "acme/app" }] })),
  http.get("https://api.github.com/repos/acme/app", () => HttpResponse.json({ full_name: "acme/app" })),
  http.get("https://api.github.com/repos/o/r/actions/runs/401", () => new HttpResponse(null, { status: 401 })),
  http.get("https://api.github.com/repos/o/r/actions/runs/403", () =>
    HttpResponse.json({ message: "Resource not accessible by personal access token" }, { status: 403 }),
  ),
  http.get("https://api.github.com/repos/o/r/actions/runs/429", () =>
    HttpResponse.json({ message: "rate" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } }),
  ),
  http.get("https://api.github.com/repos/o/r/actions/runs/404", () => new HttpResponse(null, { status: 404 })),
  // Run artifacts (SYNTHETIC): two pages, and failures on the same endpoint.
  http.get("https://api.github.com/repos/o/r/actions/runs/7/artifacts", ({ request }) =>
    new URL(request.url).searchParams.get("page") === "2"
      ? HttpResponse.json({ total_count: 2, artifacts: [{ id: 2 }] })
      : HttpResponse.json({ total_count: 2, artifacts: [{ id: 1 }] }, { headers: { Link: '<https://api.github.com/repos/o/r/actions/runs/7/artifacts?per_page=100&page=2>; rel="next"' } }),
  ),
  http.get("https://api.github.com/repos/o/r/actions/runs/404/artifacts", () => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
  http.get("https://api.github.com/repos/o/r/actions/runs/401/artifacts", () => new HttpResponse(null, { status: 401 })),
  http.get("https://api.github.com/repos/o/r/actions/runs/403/artifacts", () => HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 })),
  http.get("https://api.github.com/repos/o/r/actions/runs/429/artifacts", () => HttpResponse.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "60" } })),
  http.get("https://api.github.com/repos/o/r/actions/runs/500/artifacts", () => new HttpResponse(null, { status: 500 })),
  http.get("http://localhost:5173/__fixtures/api/repos/o/r/actions/runs/7", () => HttpResponse.json({ id: 7 })),
  http.get("https://api.github.com/user/repos", ({ request }) =>
    HttpResponse.json([{ full_name: "o/r", name: "r", owner: { login: "o" }, private: true }], {
      headers: new URL(request.url).searchParams.get("page") === "1" ? { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' } : {},
    }),
  ),
  http.get("https://api.github.com/repos/o/r/actions/runs", ({ request }) => {
    seenQueries.push(new URL(request.url).search);
    return HttpResponse.json({ total_count: 1, workflow_runs: [{ id: 1 }] });
  }),
  http.get("https://api.github.com/repos/o/r/actions/workflows/42/runs", ({ request }) => {
    seenQueries.push(`workflow42${new URL(request.url).search}`);
    return HttpResponse.json(
      { total_count: 60, workflow_runs: [{ id: 2 }] },
      { headers: { Link: '<https://api.github.com/repos/o/r/actions/workflows/42/runs?page=2>; rel="next"' } },
    );
  }),
  http.get("https://api.github.com/repos/o/r/actions/workflows", () => HttpResponse.json({ total_count: 1, workflows: [{ id: 42, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] })),
  http.get("https://api.github.com/repos/o/r/contents/.github/workflows/ci.yml", ({ request }) =>
    new URL(request.url).searchParams.get("ref") === "abc123"
      ? HttpResponse.json({ type: "file", encoding: "base64", content: Buffer.from(WORKFLOW_TEXT).toString("base64").replace(/.{20}/g, "$&\n") })
      : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
);
const seenQueries: string[] = [];
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
    expect(seen[0]!.url).toBe("https://api.github.com/repos/o/r/actions/runs/7/jobs?filter=latest&per_page=100");
  });

  it("searches repositories by name (optionally within one owner) and reads one repository, with GET only", async () => {
    expect(await live.searchRepos(" pay  app ", "acme")).toEqual({ repos: [{ full_name: "acme/app" }], totalCount: 1, incomplete: false });
    await live.searchRepos("", "acme");
    expect(await live.getRepo({ owner: "acme", repo: "app" })).toMatchObject({ full_name: "acme/app" });
    const urls = seen.map((s) => `${s.method} ${decodeURIComponent(s.url).replace(/\+/g, " ")}`);
    expect(urls).toEqual([
      "GET https://api.github.com/search/repositories?q=pay app in:name user:acme fork:true&per_page=30",
      "GET https://api.github.com/search/repositories?q=user:acme fork:true&per_page=30&sort=updated",
      "GET https://api.github.com/repos/acme/app",
    ]);
  });

  it("reads one run attempt and its own jobs (paginated) with GET only; a missing attempt is an explicit failure", async () => {
    expect(await live.getRun(ref, 1)).toMatchObject({ id: 7, run_attempt: 1 });
    expect((await live.getJobs(ref, 1)).map((j) => j.id)).toEqual([11, 12]);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r/actions/runs/7/attempts/1",
      "GET https://api.github.com/repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100",
      "GET https://api.github.com/repos/o/r/actions/runs/7/attempts/1/jobs?page=2",
    ]);
    const error = await live.getRun(ref, 9).catch((e: unknown) => e);
    expect((error as GitHubError).failure).toEqual({ kind: "not-found-or-no-permission" });
  });

  it("reads an earlier attempt's own jobs, not the latest, and keeps each job's reported attempt as GitHub sent it", async () => {
    expect((await live.getJobs(ref, 1)).map((j) => j.id)).toEqual([11, 12]);
    expect((await live.getJobs(ref)).map((j) => j.id)).toEqual([1, 2]);
    // A job listed in attempt 2 but run in attempt 1 is returned as reported, so the comparison can label it.
    expect((await live.getJobs(ref, 2)).map((j) => [j.id, j.run_attempt])).toEqual([
      [11, 1],
      [21, 2],
    ]);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100",
      "GET https://api.github.com/repos/o/r/actions/runs/7/attempts/1/jobs?page=2",
      "GET https://api.github.com/repos/o/r/actions/runs/7/jobs?filter=latest&per_page=100",
      "GET https://api.github.com/repos/o/r/actions/runs/7/jobs?page=2",
      "GET https://api.github.com/repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100",
    ]);
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

describe("repository, workflow and run-list calls", () => {
  it("lists repositories and reports whether another page exists", async () => {
    const page = await live.listRepos(1);
    expect(page.repos.map((r) => r.full_name)).toEqual(["o/r"]);
    expect(page.hasNext).toBe(true);
    expect((await live.listRepos(2)).hasNext).toBe(false);
  });

  it("maps run filters to GitHub's query parameters, and the workflow filter to the workflow's own endpoint", async () => {
    seenQueries.length = 0;
    const plain = await live.listRuns({ owner: "o", repo: "r" }, { status: "failure", branch: "feature/x", event: "push" }, 2, 25);
    expect(plain).toEqual({ runs: [{ id: 1 }], totalCount: 1, hasNext: false });
    const byWorkflow = await live.listRuns({ owner: "o", repo: "r" }, { workflowId: 42 }, 1, 25);
    expect(byWorkflow.hasNext).toBe(true);
    expect(seenQueries).toEqual(["?per_page=25&page=2&status=failure&branch=feature%2Fx&event=push", "workflow42?per_page=25&page=1"]);
    expect((await live.listWorkflows({ owner: "o", repo: "r" }))[0]!.path).toBe(".github/workflows/ci.yml");
  });

  it("reads a workflow file at an exact commit and decodes UTF-8 base64", async () => {
    expect(await live.getWorkflowFile({ owner: "o", repo: "r" }, ".github/workflows/ci.yml", "abc123")).toBe(WORKFLOW_TEXT);
    const error = await live.getWorkflowFile({ owner: "o", repo: "r" }, ".github/workflows/ci.yml", "other").catch((e: unknown) => e);
    expect((error as GitHubError).failure).toEqual({ kind: "not-found-or-no-permission" });
  });
});

describe("run artifacts", () => {
  it("lists one run's artifacts, 100 per page, with GET only, and reports a next page", async () => {
    const first = await live.listRunArtifacts(ref);
    expect(first).toEqual({ body: { total_count: 2, artifacts: [{ id: 1 }] }, hasNext: true });
    expect(await live.listRunArtifacts(ref, 2)).toEqual({ body: { total_count: 2, artifacts: [{ id: 2 }] }, hasNext: false });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r/actions/runs/7/artifacts?per_page=100",
      "GET https://api.github.com/repos/o/r/actions/runs/7/artifacts?per_page=100&page=2",
    ]);
  });

  it.each([
    [404, { kind: "not-found-or-no-permission" }],
    [401, { kind: "auth-failed" }],
    [403, { kind: "permission", detail: "Resource not accessible by integration" }],
    [429, { kind: "rate-limited" }],
    [500, { kind: "http-error", status: 500 }],
  ])("keeps the classification of HTTP %s", async (runId, failure) => {
    const error = await live.listRunArtifacts({ ...ref, runId }).catch((e: unknown) => e);
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
