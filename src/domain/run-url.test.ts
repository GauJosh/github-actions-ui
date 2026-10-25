import { describe, expect, it } from "vitest";
import { parseHash, parseRepo, parseRunUrl, routeToHash } from "./run-url";

describe("parseRunUrl", () => {
  it("parses run, job and attempt URLs", () => {
    expect(parseRunUrl("https://github.com/GauJosh/gha-ui-fixtures/actions/runs/39366140909")).toEqual({
      owner: "GauJosh",
      repo: "gha-ui-fixtures",
      runId: 39366140909,
    });
    expect(parseRunUrl(" https://github.com/o/r/actions/runs/1/job/2?pr=3 ")).toEqual({ owner: "o", repo: "r", runId: 1, jobId: 2 });
    expect(parseRunUrl("https://github.com/o/r/actions/runs/1/attempts/2")).toEqual({ owner: "o", repo: "r", runId: 1, attempt: 2 });
    expect(parseRunUrl("https://github.com/o/r/actions/runs/1/attempts/0")).toEqual({ owner: "o", repo: "r", runId: 1 });
  });

  it("rejects other URLs", () => {
    for (const url of ["https://example.com/o/r/actions/runs/1", "https://github.com/o/r/pull/1", "javascript:alert(1)", ""]) {
      expect(parseRunUrl(url)).toBeNull();
    }
  });
});

describe("parseRepo", () => {
  it("accepts owner/repo and repository URLs only", () => {
    expect(parseRepo("GauJosh/gha-ui-fixtures")).toEqual({ owner: "GauJosh", repo: "gha-ui-fixtures" });
    expect(parseRepo("https://github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    for (const bad of ["o", "o/r/x", "../x/y", "o r/x"]) expect(parseRepo(bad)).toBeNull();
  });
});

describe("hash routes", () => {
  it("round-trips run, job, log and line", () => {
    const route = { run: { owner: "o", repo: "r", runId: 1 }, jobId: 2, line: 215057, log: true };
    expect(routeToHash(route)).toBe("#/runs/o/r/1/jobs/2/L215057");
    expect(parseHash(routeToHash(route))).toEqual(route);
    expect(parseHash("#/runs/o/r/1/jobs/2/log")).toEqual({ run: { owner: "o", repo: "r", runId: 1 }, jobId: 2, log: true });
    expect(parseHash("#/runs/o/r/1/jobs/2")).toEqual({ run: { owner: "o", repo: "r", runId: 1 }, jobId: 2 });
    expect(parseHash("#/nonsense")).toEqual({});
  });

  it("round-trips phase, reusable call, job, log and the graph view", () => {
    const route = { run: { owner: "o", repo: "r", runId: 1 }, phase: "env:stage", call: "ci", jobId: 9, log: true };
    expect(routeToHash(route)).toBe("#/runs/o/r/1/phases/env%3Astage/calls/ci/jobs/9/log");
    expect(parseHash(routeToHash(route))).toEqual(route);
    const graph = { run: { owner: "o", repo: "r", runId: 1 }, jobId: 9, view: "graph" as const };
    expect(routeToHash(graph)).toBe("#/runs/o/r/1/jobs/9?view=graph");
    expect(parseHash(routeToHash(graph))).toEqual(graph);
  });

  it("round-trips a step (which opens the log), with or without a line and the phase or graph context", () => {
    const step = { run: { owner: "o", repo: "r", runId: 1 }, phase: "stage", jobId: 9, step: 4, log: true };
    expect(routeToHash(step)).toBe("#/runs/o/r/1/phases/stage/jobs/9/steps/4");
    expect(parseHash(routeToHash(step))).toEqual(step);
    const line = { ...step, line: 158 };
    expect(routeToHash(line)).toBe("#/runs/o/r/1/phases/stage/jobs/9/steps/4/L158");
    expect(parseHash(routeToHash(line))).toEqual(line);
    const graph = { run: { owner: "o", repo: "r", runId: 1 }, jobId: 9, step: 2, log: true, view: "graph" as const };
    expect(routeToHash(graph)).toBe("#/runs/o/r/1/jobs/9/steps/2?view=graph");
    expect(parseHash(routeToHash(graph))).toEqual(graph);
    expect(parseHash("#/runs/o/r/1/jobs/9/steps/x")).toEqual({});
  });

  it("round-trips a run attempt with and without a view; the latest attempt has no parameter", () => {
    const run = { owner: "o", repo: "r", runId: 1 };
    expect(routeToHash({ run, attempt: 2 })).toBe("#/runs/o/r/1?attempt=2");
    expect(parseHash("#/runs/o/r/1?attempt=2")).toEqual({ run, attempt: 2 });
    const both = { run, jobId: 9, log: true, view: "timeline" as const, attempt: 1 };
    expect(routeToHash(both)).toBe("#/runs/o/r/1/jobs/9/log?view=timeline&attempt=1");
    expect(parseHash(routeToHash(both))).toEqual(both);
    expect(parseHash("#/runs/o/r/1?attempt=0")).toEqual({ run });
    expect(parseHash("#/runs/o/r/1?attempt=x&view=bogus")).toEqual({ run });
  });

  it("round-trips a comparison baseline (always with an explicit attempt) and search text", () => {
    const run = { owner: "o", repo: "r", runId: 1 };
    const compare = { run, view: "compare" as const, attempt: 2, base: { runId: 1, attempt: 1 } };
    expect(routeToHash(compare)).toBe("#/runs/o/r/1?view=compare&attempt=2&base=1.1");
    expect(parseHash(routeToHash(compare))).toEqual(compare);
    expect(parseHash("#/runs/o/r/1?view=compare&base=7")).toEqual({ run, view: "compare" });
    expect(parseHash("#/runs/o/r/1?view=compare&base=7.0")).toEqual({ run, view: "compare" });
    const search = { run, view: "search" as const, jobId: 4, line: 12, log: true, q: "Error: a&b" };
    expect(routeToHash(search)).toBe("#/runs/o/r/1/jobs/4/L12?view=search&q=Error%3A%20a%26b");
    expect(parseHash(routeToHash(search))).toEqual(search);
  });

  it("round-trips the failure impact shown on the graph, including a node key with separators", () => {
    const run = { owner: "o", repo: "r", runId: 1 };
    const all = { run, view: "graph" as const, impact: "all" };
    expect(routeToHash(all)).toBe("#/runs/o/r/1?view=graph&impact=all");
    expect(parseHash(routeToHash(all))).toEqual(all);
    const one = { run, view: "graph" as const, jobId: 9, step: 3, log: true, impact: "def:cd/deploy-dev/deploy" };
    expect(routeToHash(one)).toBe("#/runs/o/r/1/jobs/9/steps/3?view=graph&impact=def%3Acd%2Fdeploy-dev%2Fdeploy");
    expect(parseHash(routeToHash(one))).toEqual(one);
  });

  it("round-trips the repository run list with its filters", () => {
    const route = { repo: { owner: "o", repo: "r" }, filters: { status: "failure", branch: "feature/x", event: "push", workflowId: 7 } };
    expect(routeToHash(route)).toBe("#/repos/o/r?status=failure&workflow=7&branch=feature%2Fx&event=push");
    expect(parseHash(routeToHash(route))).toEqual(route);
    expect(parseHash("#/repos/o/r")).toEqual({ repo: { owner: "o", repo: "r" }, filters: {} });
  });
});
