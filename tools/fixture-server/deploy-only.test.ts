// The SYNTHETIC "deployment-only rollout" scenario through the live-mode pipeline (hierarchy loader, hierarchy
// graph, overview) and the SYNTHETIC multi-attempt runs as the fixture API serves them. Reproduces the reported
// problems: a declared CI call with no job in the run became a "ci" node ("no job in this run"), and only the latest
// attempt of a run could be inspected.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildHierarchyGraph } from "../../src/domain/graph/hierarchy";
import { layoutGrouped } from "../../src/domain/graph/layout";
import { readWorkflowDefinition, type WorkflowDefinition } from "../../src/domain/graph/workflow-definition";
import { buildOverview, type ReleaseOverview } from "../../src/domain/phases/phases";
import type { Job, Run } from "../../src/domain/types";
import { GitHubError, type GitHubClient } from "../../src/github/client";
import { loadWorkflowTree } from "../../src/runs/workflow-tree";
import { ENTERPRISE_OWNER, ENTERPRISE_REPO, enterpriseRuns, type EnterpriseRun } from "./enterprise.ts";

const all = enterpriseRuns();
const byId = new Map(all.map((r) => [r.run.id, r]));

function clientFor(r: EnterpriseRun): GitHubClient {
  return {
    async getWorkflowFile(ref: { owner: string; repo: string }, path: string, commit: string) {
      const own = ref.owner === ENTERPRISE_OWNER && ref.repo === ENTERPRISE_REPO && commit === r.run.head_sha ? r.files.get(path) : undefined;
      if (typeof own !== "string") throw new GitHubError({ kind: "not-found-or-no-permission" });
      return own;
    },
  } as unknown as GitHubClient;
}

async function analyse(r: EnterpriseRun, jobs = r.jobs) {
  const definition = readWorkflowDefinition(parse(r.files.get(r.run.path)!)) as WorkflowDefinition;
  const run = r.run as unknown as Run;
  const { tree } = await loadWorkflowTree(clientFor(r), run, {
    definition,
    file: { repo: `${ENTERPRISE_OWNER}/${ENTERPRISE_REPO}`, path: r.run.path, revision: r.run.head_sha, source: "run-commit" },
  });
  const graph = buildHierarchyGraph(jobs as unknown as Job[], tree, run);
  const overview = buildOverview(graph, definition, { manifest: null }) as ReleaseOverview;
  return { graph, overview };
}
const edgeList = (g: { edges: { from: string; to: string }[] }) => g.edges.map((e) => `${e.from} -> ${e.to}`).sort();

describe("deployment-only run with a declared CI call that has no job in the run (synthetic)", () => {
  it("draws only the jobs GitHub reported: no ci node, no ci phase, no edge from ci", async () => {
    const r = byId.get(990009001)!;
    expect(r.jobs.some((j) => String(j.name).startsWith("ci"))).toBe(false);
    const { graph, overview } = await analyse(r);
    expect(graph.nodes.map((n) => n.key).sort()).toEqual(
      ["def:audit-log", "def:canary-eu", "def:deploy-blue", "def:fetch-artifact", "def:notify", "def:prepare-config", "def:shift-traffic", "def:verify-blue"].sort(),
    );
    expect(graph.nodes.every((n) => n.members.length > 0)).toBe(true);
    expect(graph.declared?.map((d) => d.key)).toEqual(["def:ci"]);
    expect(edgeList(graph)).toEqual(
      [
        "def:prepare-config -> def:deploy-blue",
        "def:fetch-artifact -> def:deploy-blue",
        "def:fetch-artifact -> def:canary-eu",
        "def:deploy-blue -> def:verify-blue",
        "def:verify-blue -> def:shift-traffic",
        "def:canary-eu -> def:shift-traffic",
        "def:shift-traffic -> def:notify",
      ].sort(),
    );
    expect(graph.evidence.notes.join(" ")).toContain("Not drawn: `deploy-blue` needs `ci`");
    // Phases come from the environments this workflow declares, whatever they are called; nothing named ci.
    expect(overview.phases.map((p) => p.name)).toEqual(["Before deployment", "blue", "canary-eu", "live"]);
    expect(overview.phases.every((p) => p.nodeKeys.length > 0)).toBe(true);
  });

  it("several independent entry points and a parallel branch, from `needs` only", async () => {
    const { graph } = await analyse(byId.get(990009001)!);
    const targets = new Set(graph.edges.map((e) => e.to));
    expect(graph.nodes.filter((n) => !targets.has(n.key)).map((n) => n.key).sort()).toEqual(["def:audit-log", "def:fetch-artifact", "def:prepare-config"]);
    // canary-eu does not depend on deploy-blue or verify-blue (parallel), even if it finished after them.
    expect(graph.edges.some((e) => e.to === "def:canary-eu" && e.from !== "def:fetch-artifact")).toBe(false);
  });

  it("grouped column layout: an edge never runs under a job it does not come from", async () => {
    const { graph, overview } = await analyse(byId.get(990009001)!);
    const groups = new Map<string, string>();
    for (const p of overview.phases) for (const k of p.nodeKeys) groups.set(k, p.name);
    const l = layoutGrouped(
      graph.nodes.map((n) => ({ key: n.key, height: 60, column: groups.get(n.key) })),
      graph.edges,
      { vertical: true, bundle: true },
    );
    // The three entry jobs share one row of "Before deployment"; edges from the left two leave from below the row.
    const row = ["def:prepare-config", "def:fetch-artifact", "def:audit-log"].map((k) => l.boxes.get(k)!);
    expect(new Set(row.map((b) => b.y)).size).toBe(1);
    const rowBottom = row[0]!.y + row[0]!.height;
    for (const e of l.edges.filter((x) => x.from === "def:prepare-config" || x.from === "def:fetch-artifact")) {
      const a = l.boxes.get(e.from)!;
      const [, sx, sy] = /^M (\S+) (\S+)/.exec(e.path)!.map(Number);
      expect(sy).toBe(a.y + a.height);
      expect(sx!).toBeGreaterThan(a.x);
      expect(sx!).toBeLessThan(a.x + a.width);
      // Its horizontal run is below the row, not through the jobs to its right.
      const run = / L (\S+) (\S+) C /.exec(e.path)!.map(Number);
      expect(run[2]!).toBeGreaterThan(rowBottom);
    }
    // Audit log needs nothing and nothing needs it: no edge touches it.
    expect(l.edges.filter((x) => x.from === "def:audit-log")).toEqual([]);
  });

  it("when GitHub does report the CI call, it is an execution node again with its edge", async () => {
    const r = byId.get(990009001)!;
    const ci = { ...r.jobs[0]!, id: 1, name: "ci / lint", status: "completed", conclusion: "success" };
    const { graph, overview } = await analyse(r, [ci, ...r.jobs]);
    expect(graph.nodes.some((n) => n.key === "def:ci" || n.key.startsWith("def:ci/"))).toBe(true);
    expect(graph.edges).toContainEqual({ from: "def:ci", to: "def:deploy-blue" });
    expect(overview.phases.map((p) => p.name)).toContain("ci");
  });
});

describe("synthetic runs with several attempts", () => {
  it("each attempt has its own jobs, ids, attempt numbers and results; the latest keeps the run's identity", () => {
    const r = byId.get(990002005)!;
    expect(r.run.run_attempt).toBe(3);
    expect(r.attempts!.map((a) => a.run.run_attempt)).toEqual([1, 2]);
    const ids = [r.jobs, ...r.attempts!.map((a) => a.jobs)].map((jobs) => new Set(jobs.map((j) => j.id)));
    expect(ids[0]!.size + ids[1]!.size + ids[2]!.size).toBe(new Set([...ids[0]!, ...ids[1]!, ...ids[2]!]).size);
    expect(r.jobs.every((j) => j.run_attempt === 3)).toBe(true);
    expect(r.attempts![0]!.jobs.every((j) => j.run_attempt === 1)).toBe(true);
    expect(r.attempts!.map((a) => a.run.conclusion)).toEqual(["failure", "failure"]);
    expect(r.run.conclusion).toBe("success");
    expect(r.attempts![0]!.jobs.find((j) => j.name === "smoke-dev")!.conclusion).toBe("failure");
    expect(r.attempts![1]!.jobs.find((j) => j.name === "e2e-test")!.conclusion).toBe("failure");
    expect(new Set([r.run.created_at, ...r.attempts!.map((a) => a.run.created_at)]).size).toBe(1);
    expect(String(r.attempts![0]!.run.run_started_at) < String(r.attempts![1]!.run.run_started_at)).toBe(true);
    expect(r.attempts![0]!.logsExpired).toBe(true);
  });

  it("single-attempt runs are unchanged", () => {
    const r = byId.get(990002001)!;
    expect(r.run.run_attempt).toBe(1);
    expect(r.attempts).toBeUndefined();
  });
});
