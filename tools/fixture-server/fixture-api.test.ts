// Drives the fixture middleware in-process (no sockets: the unit-test network guard forbids them).
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createFixtureMiddleware } from "./fixture-api.ts";

const middleware = createFixtureMiddleware({ repoRoot: resolve("."), lockPath: resolve("fixtures.lock.json") });

type Result = { status: number; headers: Record<string, string>; body: string };

function call(path: string, method = "GET", headers: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let status = 0;
    let head: Record<string, string> = {};
    const res = {
      writeHead(s: number, h: Record<string, string>) {
        status = s;
        head = h;
        return res;
      },
      write(chunk: Buffer) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.from(chunk));
        done({ status, headers: head, body: Buffer.concat(chunks).toString("utf8") });
      },
      once() {},
    } as unknown as ServerResponse;
    const req = { url: `/__fixtures/api${path}`, method, headers: { host: "127.0.0.1:4317", ...headers } } as unknown as IncomingMessage;
    middleware(req, res, () => done({ status: -1, headers: {}, body: "next" }));
  });
}
const json = async (path: string) => JSON.parse((await call(path)).body);

describe("fixture API", () => {
  it("lists repositories, including the clearly labelled synthetic and empty ones", async () => {
    const repos = (await json("/user/repos?per_page=100")) as { full_name: string; description: string }[];
    expect(repos.map((r) => r.full_name)).toEqual(expect.arrayContaining(["GauJosh/gha-ui-fixtures", "GauJosh/kubernetes-ai-investigator", "fixtures/synthetic", "fixtures/empty"]));
    expect(repos.find((r) => r.full_name === "fixtures/synthetic")!.description).toMatch(/SYNTHETIC/);
  });

  it("paginates runs newest first with an absolute Link to the next page", async () => {
    const first = await call("/repos/GauJosh/gha-ui-fixtures/actions/runs?per_page=10&page=1");
    const body = JSON.parse(first.body) as { total_count: number; workflow_runs: { created_at: string }[] };
    expect(body.total_count).toBe(34);
    expect(body.workflow_runs).toHaveLength(10);
    const times = body.workflow_runs.map((r) => r.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(first.headers.Link).toBe('<http://127.0.0.1:4317/__fixtures/api/repos/GauJosh/gha-ui-fixtures/actions/runs?per_page=10&page=2>; rel="next"');
    const last = await call("/repos/GauJosh/gha-ui-fixtures/actions/runs?per_page=10&page=4");
    expect(JSON.parse(last.body).workflow_runs).toHaveLength(4);
    expect(last.headers.Link).toBeUndefined();
  });

  it("filters by status or conclusion, branch, event and workflow", async () => {
    const failed = (await json("/repos/GauJosh/gha-ui-fixtures/actions/runs?status=failure&per_page=100")).workflow_runs as { conclusion: string }[];
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.conclusion === "failure")).toBe(true);
    const workflows = (await json("/repos/GauJosh/gha-ui-fixtures/actions/workflows")).workflows as { id: number; name: string }[];
    const s05 = workflows.find((w) => w.name.startsWith("s05"))!;
    const byWorkflow = (await json(`/repos/GauJosh/gha-ui-fixtures/actions/workflows/${s05.id}/runs?per_page=100`)).workflow_runs as { name: string }[];
    expect(byWorkflow).toHaveLength(2);
    expect((await json("/repos/fixtures/synthetic/actions/runs?event=pull_request")).total_count).toBe(1);
    expect((await json("/repos/fixtures/synthetic/actions/runs?branch=no-such-branch")).total_count).toBe(0);
    expect((await json("/repos/fixtures/empty/actions/runs")).total_count).toBe(0);
  });

  it("serves a workflow file only at the run's own commit", async () => {
    const run = await json("/repos/GauJosh/gha-ui-fixtures/actions/runs/39366120652");
    const file = await json(`/repos/GauJosh/gha-ui-fixtures/contents/${run.path}?ref=${run.head_sha}`);
    const text = Buffer.from(file.content, "base64").toString("utf8");
    expect(Object.keys(parse(text).jobs)).toEqual(["build", "test", "deploy", "report"]);
    expect((await call(`/repos/GauJosh/gha-ui-fixtures/contents/${run.path}?ref=main`)).status).toBe(404);
  });

  it("returns a permission error for the synthetic run whose workflow file is unreadable", async () => {
    const run = await json("/repos/fixtures/synthetic/actions/runs/990000106");
    const r = await call(`/repos/fixtures/synthetic/contents/${run.path}?ref=${run.head_sha}`);
    expect(r.status).toBe(403);
  });

  it("serves synthetic job logs with ranges, and 404 for skipped jobs", async () => {
    const jobs = (await json("/repos/fixtures/synthetic/actions/runs/990000101/jobs")).jobs as { id: number; name: string; conclusion: string }[];
    const failed = jobs.find((j) => j.conclusion === "failure")!;
    const head = await call(`/repos/fixtures/synthetic/actions/jobs/${failed.id}/logs`, "HEAD");
    expect(Number(head.headers["Content-Length"])).toBeGreaterThan(0);
    const log = await call(`/repos/fixtures/synthetic/actions/jobs/${failed.id}/logs`);
    expect(log.body).toContain("[synthetic]");
    expect(log.body).toContain("##[error]Process completed with exit code 1.");
    const skipped = jobs.find((j) => j.conclusion === "skipped")!;
    expect((await call(`/repos/fixtures/synthetic/actions/jobs/${skipped.id}/logs`)).status).toBe(404);
  });

  it("is read-only and scoped to known repositories", async () => {
    expect((await call("/repos/GauJosh/gha-ui-fixtures/actions/runs", "POST")).status).toBe(405);
    expect((await call("/repos/someone/else/actions/runs")).status).toBe(404);
  });
});
