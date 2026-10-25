// Pipeline-wide search over run metadata (SYNTHETIC workflow and jobs).
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph } from "../graph/build";
import { readWorkflowDefinition, type WorkflowDefinition } from "../graph/workflow-definition";
import { analyzeImpact } from "../insights/impact";
import { compileSearch } from "../logs/view";
import type { Job } from "../types";
import { buildSearchIndex, searchIndex } from "./run-search";

const step = (number: number, name: string, conclusion = "success") => ({ number, name, status: "completed", conclusion, started_at: null, completed_at: null });
const job = (id: number, name: string, conclusion: string, steps = [step(1, "Set up job"), step(2, "Run tests", conclusion)]): Job =>
  ({ id, name, status: "completed", conclusion, started_at: null, completed_at: null, html_url: null, steps }) as Job;
const YAML = `
jobs:
  build: { steps: [{ name: Compile, run: "make build\\nmake package" }] }
  deploy: { needs: build, environment: staging, if: "github.ref == 'refs/heads/main'", steps: [{ uses: ./.github/actions/deploy }] }
`;
const jobs = [job(1, "build", "failure"), job(2, "deploy", "skipped", [])];
const graph = buildRunGraph(jobs, readWorkflowDefinition(parse(YAML)) as WorkflowDefinition, { file: { path: "ci.yml", revision: "a".repeat(40) } });
const index = buildSearchIndex(graph, jobs, analyzeImpact(graph, { status: "completed", conclusion: "failure" }));
const find = (query: string, kinds?: Parameters<typeof searchIndex>[2], caseSensitive = false) => {
  const m = compileSearch({ query, caseSensitive, wholeWord: false, regex: false });
  if (m && "error" in m) throw new Error(m.error);
  return searchIndex(index, m, kinds);
};

describe("run metadata search", () => {
  it("finds jobs, steps, workflow source lines and failure facts, each with its place", () => {
    expect(find("run tests", ["step"]).map((m) => [m.kind, m.context, m.step])).toEqual([["step", "step 2 of build", 2]]);
    expect(find("make package")).toMatchObject([{ kind: "source", context: "build › Compile (workflow file), run:", jobId: 1 }]);
    expect(find("staging").map((m) => m.text)).toEqual(["environment: staging"]);
    expect(find("not run because").map((m) => [m.text, m.jobId])).toEqual([["deploy not run because build failed", 2]]);
    expect(find("failed at step")).toMatchObject([{ kind: "failure", jobId: 1, step: 2 }]);
  });

  it("filters by kind, matches case-insensitively unless asked, and returns match ranges", () => {
    expect(find("DEPLOY", ["job"]).map((m) => m.text)).toEqual(["deploy"]);
    expect(find("DEPLOY", ["job"], true)).toEqual([]);
    expect(find("compile")[0]!.ranges).toEqual([[6, 13]]);
    expect(find("")).toEqual([]);
  });
});
