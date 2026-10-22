// The synthetic scenarios produce the graph structures they are meant to exercise.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph } from "../../src/domain/graph/build";
import { readWorkflowDefinition } from "../../src/domain/graph/workflow-definition";
import type { Job, Run } from "../../src/domain/types";
import { syntheticGraphRuns } from "./synthetic-graphs.ts";

const runs = new Map(syntheticGraphRuns().map((r) => [r.run.id, r]));

function graphOf(id: number) {
  const s = runs.get(id)!;
  const jobs = s.jobs as unknown as Job[];
  if (typeof s.workflow !== "string") return buildRunGraph(jobs, null, { unavailableReason: "403" });
  const def = readWorkflowDefinition(parse(s.workflow));
  if ("error" in def) throw new Error(def.error);
  return buildRunGraph(jobs, def, { run: s.run as unknown as Run, file: { path: s.run.path, revision: s.run.head_sha } });
}

describe("synthetic scenarios", () => {
  it("are all labelled [synthetic]", () => {
    for (const s of runs.values()) expect(String(s.run.display_title)).toMatch(/^\[synthetic\]/);
  });

  it("CI: parallel starts, a 3-job matrix with one failure, and fan-in", () => {
    const g = graphOf(990000101);
    expect(g.nodes.find((n) => n.yamlId === "unit")).toMatchObject({ kind: "matrix", status: "failure", counts: { failure: 1, success: 2 } });
    expect(g.edges.filter((e) => e.to === "def:report")).toHaveLength(6);
    expect(g.edges.filter((e) => e.to === "def:build").map((e) => e.from)).toEqual(["def:lint", "def:typecheck", "def:unit"]);
  });

  it("CD: running, waiting and queued matrix legs, and a declared job not created yet", () => {
    const g = graphOf(990000102);
    expect(g.nodes.find((n) => n.yamlId === "deploy-prod")!.counts).toEqual({ in_progress: 1, waiting: 1, queued: 1 });
    expect(g.nodes.some((n) => n.yamlId === "verify-prod")).toBe(false);
    expect(g.declared?.map((d) => d.id)).toEqual(["verify-prod"]);
    expect(g.edges.filter((e) => e.to === "def:deploy-staging").map((e) => e.from)).toEqual(["def:smoke-dev", "def:security-scan"]);
  });

  it("reusable: local and remote calls grouped with their inner jobs and resolved commits", () => {
    const g = graphOf(990000103);
    const tests = g.nodes.find((n) => n.yamlId === "tests")!;
    expect(tests.members.map((m) => m.label).sort()).toEqual(["lint", "unit"]);
    expect(tests.resolvedWorkflow?.path).toContain("/.github/workflows/_tests.yml@");
    expect(g.nodes.find((n) => n.yamlId === "deploy")!.resolvedWorkflow?.path).toBe("acme-org/shared-workflows/.github/workflows/deploy.yml@v2");
    expect(g.edges).toEqual([
      { from: "def:tests", to: "def:deploy" },
      { from: "def:deploy", to: "def:notify" },
    ]);
  });

  it("large: 108 jobs and 184 edges, all matched", () => {
    const g = graphOf(990000105);
    expect(g.nodes).toHaveLength(108);
    expect(g.edges).toHaveLength(8 + 11 * 16);
    expect(g.evidence).toMatchObject({ matchedJobs: 108, totalJobs: 108 });
  });

  it("partial: no workflow file, so no edges; a job without step data is kept", () => {
    const g = graphOf(990000106);
    expect(g.edges).toEqual([]);
    expect(g.evidence.kind).toBe("unavailable");
    expect(runs.get(990000106)!.jobs.find((j) => j.name === "audit")!.steps).toBeUndefined();
  });

  it("renamed: the unmatched job has no edges", () => {
    const g = graphOf(990000107);
    expect(g.nodes.find((n) => n.key.startsWith("job:"))!.label).toBe("compile");
    // `build` has no job in this run (it ran as "compile", which matches nothing), so `test`'s need is reported, not drawn.
    expect(g.edges).toEqual([]);
    expect(g.declared?.map((d) => d.id)).toEqual(["build"]);
    expect(g.evidence.notes.join(" ")).toContain("Not drawn: `test` needs `build`");
  });
});
