// The SYNTHETIC "promotion checks" scenario through the live-mode pipeline (hierarchy loader, hierarchy graph,
// overview) and the grouped graph layout. It reproduces the reported mis-grouping: readiness checks before PROD and
// PROD-DR that declare no environment and need DEV's validation were grouped under DEV.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildHierarchyGraph } from "../../src/domain/graph/hierarchy";
import { layoutGrouped } from "../../src/domain/graph/layout";
import { readWorkflowDefinition, type WorkflowDefinition } from "../../src/domain/graph/workflow-definition";
import { buildOverview, gatesFor, type ReleaseOverview } from "../../src/domain/phases/phases";
import type { Job, Run } from "../../src/domain/types";
import { GitHubError, type GitHubClient } from "../../src/github/client";
import { toApprovalRecords } from "../../src/runs/release";
import { loadWorkflowTree } from "../../src/runs/workflow-tree";
import { ENTERPRISE_OWNER, ENTERPRISE_REPO, enterpriseRuns, type EnterpriseRun } from "./enterprise.ts";

const runs = new Map(enterpriseRuns().filter((r) => r.scenario.id === "promotion-checks").map((r) => [r.variant.id, r]));

function clientFor(r: EnterpriseRun): GitHubClient {
  return {
    async getWorkflowFile(ref: { owner: string; repo: string }, path: string, commit: string) {
      const own = ref.owner === ENTERPRISE_OWNER && ref.repo === ENTERPRISE_REPO && commit === r.run.head_sha ? r.files.get(path) : undefined;
      const file = own ?? r.external.get(`${ref.owner}/${ref.repo}@${commit}`)?.get(path);
      if (typeof file !== "string") throw new GitHubError({ kind: "not-found-or-no-permission" });
      return file;
    },
  } as unknown as GitHubClient;
}

async function analyse(variant: string) {
  const r = runs.get(variant)!;
  const definition = readWorkflowDefinition(parse(r.files.get(r.run.path)!)) as WorkflowDefinition;
  const run = r.run as unknown as Run;
  const { tree } = await loadWorkflowTree(clientFor(r), run, {
    definition,
    file: { repo: `${ENTERPRISE_OWNER}/${ENTERPRISE_REPO}`, path: r.run.path, revision: r.run.head_sha, source: "run-commit" },
  });
  const graph = buildHierarchyGraph(r.jobs as unknown as Job[], tree, run);
  const overview = buildOverview(graph, definition, { manifest: null, gates: gatesFor(graph, toApprovalRecords(r.approvals), null) }) as ReleaseOverview;
  return { graph, overview };
}
const keysOf = (o: ReleaseOverview, name: string) => o.phases.find((p) => p.name === name)!.nodeKeys.slice().sort();

describe("promotion checks before PROD and PROD-DR (synthetic)", () => {
  it("each readiness check is grouped with the environment its call names, not with DEV", async () => {
    const { overview } = await analyse("released");
    expect(overview.phases.map((p) => `${p.name}: ${p.status}`)).toEqual(["ci: succeeded", "dev: succeeded", "prod: succeeded", "prod-dr: succeeded"]);
    expect(keysOf(overview, "dev")).toEqual(["def:cd/deploy-dev/deploy", "def:cd/deploy-dev/smoke", "def:cd/dev-rollback", "def:cd/dev-validation"].sort());
    expect(keysOf(overview, "prod")).toEqual(["def:cd/deploy-prod/deploy", "def:cd/deploy-prod/smoke", "def:cd/prod-rollback", "def:cd/prod-validation", "def:cd/ready-prod"].sort());
    expect(keysOf(overview, "prod-dr")).toEqual(["def:cd/deploy-prod-dr/deploy", "def:cd/deploy-prod-dr/smoke", "def:cd/prod-dr-rollback", "def:cd/prod-dr-validation", "def:cd/ready-prod-dr"].sort());
    expect(overview.environments.get("def:cd/ready-prod")).toEqual({ environment: "prod", provenance: "input", reason: "the call is called with `target: prod`" });
    expect(overview.environments.get("def:cd/deploy-prod/deploy")).toMatchObject({ provenance: "input" });
    expect(overview.environments.get("def:cd/prod-validation")).toMatchObject({ provenance: "declared" });
    expect(overview.environments.get("def:cd/prod-rollback")).toMatchObject({ provenance: "heuristic" });
    expect(overview.unassignedKeys).toEqual([]);
  });

  it("a failed PROD-DR validation with its rollback is attributed to PROD-DR only", async () => {
    const { overview } = await analyse("prod-dr-rolled-back");
    expect(overview.phases.map((p) => `${p.name}: ${p.status}`)).toEqual(["ci: succeeded", "dev: succeeded", "prod: succeeded", "prod-dr: recovered"]);
    expect(overview.stop?.text).toContain("Stopped in prod-dr");
  });

  it("grouped layout: one frame per environment; PROD and PROD-DR side by side, not in sequence; every edge drawn", async () => {
    const { graph, overview } = await analyse("released");
    const groups = new Map<string, string>();
    for (const p of overview.phases) for (const k of p.nodeKeys) groups.set(k, p.name);
    const l = layoutGrouped(
      graph.nodes.map((n) => ({ key: n.key, height: 60, column: groups.get(n.key) })),
      graph.edges,
      { vertical: true },
    );
    const frame = (name: string) => l.groups.find((g) => g.label === name)!;
    expect(l.groups.map((g) => g.label).sort()).toEqual(["ci", "dev", "prod", "prod-dr"]);
    // Parallel environments share a column and are stacked.
    expect(frame("prod").x + frame("prod").width / 2).toBeCloseTo(frame("prod-dr").x + frame("prod-dr").width / 2);
    expect(Math.abs(frame("prod").y - frame("prod-dr").y)).toBeGreaterThanOrEqual(frame("prod").height);
    // Ordering follows needs: CI, then DEV, then PROD / PROD-DR.
    expect(frame("ci").x + frame("ci").width).toBeLessThan(frame("dev").x);
    expect(frame("dev").x + frame("dev").width).toBeLessThan(frame("prod").x);
    // Every job sits inside its environment's frame.
    for (const [key, name] of groups) {
      const b = l.boxes.get(key)!;
      const f = frame(name);
      expect(b.x >= f.x && b.y >= f.y && b.x + b.width <= f.x + f.width && b.y + b.height <= f.y + f.height, `${key} in ${name}`).toBe(true);
    }
    // No edge is added or lost.
    expect(l.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(graph.edges.map((e) => `${e.from}->${e.to}`).sort());
    // Inside PROD, one column top to bottom by needs; the conditional rollback comes after validation.
    const y = (k: string) => l.boxes.get(k)!.y;
    const order = ["def:cd/ready-prod", "def:cd/deploy-prod/deploy", "def:cd/deploy-prod/smoke", "def:cd/prod-validation", "def:cd/prod-rollback"];
    for (let i = 1; i < order.length; i++) expect(y(order[i]!)).toBeGreaterThan(y(order[i - 1]!));
    expect(new Set(order.map((k) => l.boxes.get(k)!.x)).size).toBe(1); // a chain stays in one column
  });
});
