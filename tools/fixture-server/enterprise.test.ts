// Every enterprise variant, run through the same pipeline the app uses: workflow file → graph → phase file →
// approvals → release overview. Checks phase statuses, gates, recovery, blocked phases and the stop summary.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildRunGraph, calledWorkflowGraph } from "../../src/domain/graph/build";
import { isCustomAction, readWorkflowDefinition, type WorkflowDefinition } from "../../src/domain/graph/workflow-definition";
import { buildOverview, gatesFor, phaseGraph, readPhaseManifest, type ReleaseOverview } from "../../src/domain/phases/phases";
import type { Job, Run } from "../../src/domain/types";
import { createMarkerScanner, locateStep, mapSteps } from "../../src/domain/steps/step-map";
import { toApprovalRecords, toPendingDeployments } from "../../src/runs/release";
import { enterpriseRuns, gallery, type EnterpriseRun } from "./enterprise.ts";

const runs = enterpriseRuns();
const byKey = new Map(runs.map((r) => [`${r.scenario.id}/${r.variant.id}`, r]));

function analyse(r: EnterpriseRun) {
  const def = readWorkflowDefinition(parse(r.files.get(r.run.path)!)) as WorkflowDefinition;
  const graph = buildRunGraph(r.jobs as unknown as Job[], def, { run: r.run as unknown as Run, file: { path: r.run.path, revision: r.run.head_sha } });
  const manifest = readPhaseManifest(parse(r.files.get(".github/actions-ui-phases.yml")!), r.run.path, ".github/actions-ui-phases.yml");
  if (!manifest || "error" in manifest) throw new Error("phase file");
  const gates = gatesFor(graph, toApprovalRecords(r.approvals), toPendingDeployments(r.pending));
  const overview = buildOverview(graph, def, { manifest, gates }) as ReleaseOverview;
  const status = Object.fromEntries(overview.phases.map((p) => [p.id, p.status]));
  return { def, graph, overview, status };
}

describe("enterprise fixtures: structure", () => {
  it("are deterministic and labelled synthetic", () => {
    const again = enterpriseRuns();
    expect(JSON.stringify(again.map((r) => [r.run, r.jobs]))).toBe(JSON.stringify(runs.map((r) => [r.run, r.jobs])));
    for (const r of runs) expect(String(r.run.display_title)).toMatch(/^\[synthetic\]/);
    expect(gallery(runs).scenarios.map((s) => s.id)).toEqual(["reusable-ci", "multi-env-cd", "release", "approval-gates", "failure-rollback", "platform", "shared-cicd", "promotion-checks", "deploy-only"]);
  });

  it("represent 10+ custom actions as steps inside jobs, never as jobs", () => {
    const { def } = analyse(byKey.get("platform/success")!);
    const called = ["_ci.yml", "_security.yml"].map((f) => readWorkflowDefinition(parse(byKey.get("platform/success")!.files.get(`.github/workflows/${f}`)!)) as WorkflowDefinition);
    const actions = new Set([def, ...called].flatMap((d) => d.jobs.flatMap((j) => j.steps.map((s) => s.uses))).filter(isCustomAction));
    expect(actions.size).toBeGreaterThanOrEqual(10);
    const jobNames = byKey.get("platform/success")!.jobs.map((j) => String(j.name));
    expect(jobNames.some((n) => n.includes("deploy-helm") || n.includes("acme-org"))).toBe(false);
  });

  it("the large platform release has 70+ jobs grouped into 5 readable phases", () => {
    const { graph, overview } = analyse(byKey.get("platform/success")!);
    expect(graph.nodes.flatMap((n) => n.members).length).toBeGreaterThanOrEqual(70);
    expect(overview.phases.map((p) => p.name)).toEqual(["CI, security & artifact", "Dev", "Test", "Stage", "Prod"]);
    expect(overview.unassignedKeys).toEqual([]);
    expect(overview.phaseEdges.map((e) => `${e.from}->${e.to}`)).toEqual(expect.arrayContaining(["ci->dev", "dev->test", "test->stage", "stage->prod"]));
  });

  it("the reusable CI call keeps its own context: inner jobs and their own needs from the called workflow", () => {
    const r = byKey.get("release/success")!;
    const { graph } = analyse(r);
    const ci = graph.nodes.find((n) => n.yamlId === "ci")!;
    expect(ci.kind).toBe("reusable");
    const inner = readWorkflowDefinition(parse(r.files.get(".github/workflows/_ci.yml")!)) as WorkflowDefinition;
    const sub = calledWorkflowGraph(ci, inner, { file: { path: ".github/workflows/_ci.yml", revision: r.run.head_sha } });
    expect(sub.nodes.map((n) => n.yamlId)).toEqual(["lint", "unit", "integration", "sast", "build", "sbom"]);
    expect(sub.nodes.find((n) => n.yamlId === "unit")!.members).toHaveLength(2);
    expect(sub.edges).toEqual(expect.arrayContaining([{ from: "def:unit", to: "def:integration" }, { from: "def:build", to: "def:sbom" }]));
  });

  it("a phase detail shows only its jobs; each neighbouring phase is one labelled summary, linked by real edges", () => {
    const { graph, overview } = analyse(byKey.get("release/success")!);
    const stage = phaseGraph(graph, overview, "stage");
    expect(stage.nodes.filter((n) => !n.external).map((n) => n.yamlId).sort()).toEqual(["canary-stage", "deploy-stage", "rollback-stage", "smoke-stage"]);
    expect(stage.scope.upstream).toEqual([{ phaseId: "test", phaseName: "Test", jobs: ["e2e-test", "smoke-test"] }]);
    expect(stage.scope.downstream).toEqual([{ phaseId: "prod", phaseName: "Prod", jobs: ["deploy-prod"] }]);
    const phaseOfKey = (k: string) => overview.nodePhase.get(k);
    for (const e of stage.edges) {
      const inner = e.from.startsWith("ext:") ? e.to : e.from;
      const ext = e.from.startsWith("ext:") ? e.from : e.to;
      if (!ext.startsWith("ext:")) {
        expect(graph.edges).toContainEqual(e);
        continue;
      }
      const otherPhase = ext.split(":")[2];
      const real = graph.edges.some((g) => (e.from === ext ? g.to === inner && phaseOfKey(g.from) === otherPhase : g.from === inner && phaseOfKey(g.to) === otherPhase));
      expect(real).toBe(true);
    }
  });

  it("the 79-job Stage phase: service lanes from the phase file, and summaries instead of a mesh of cross-phase edges", () => {
    const { graph, overview } = analyse(byKey.get("platform/billing-stage-failed")!);
    const stage = phaseGraph(graph, overview, "stage");
    const crossing = graph.edges.filter((e) => stage.nodes.some((n) => n.key === e.from && !n.external) !== stage.nodes.some((n) => n.key === e.to && !n.external)).length;
    const summaryEdges = stage.edges.filter((e) => e.from.startsWith("ext:") || e.to.startsWith("ext:")).length;
    expect(crossing).toBe(84);
    expect(summaryEdges).toBe(13);
    expect(stage.scope.upstream[0]!.jobs).toHaveLength(7);
    expect(stage.scope.downstream[0]!.jobs).toHaveLength(6);
    expect(overview.nodeGroup.get("def:deploy-billing-stage")).toBe("billing");
    expect(overview.nodeGroup.get("def:smoke-billing-stage")).toBe("billing");
    expect(overview.nodeGroup.has("def:canary-stage")).toBe(false);
  });
});

describe("enterprise fixtures: release overview per variant", () => {
  const cases: [string, Record<string, string>, RegExp | null][] = [
    ["reusable-ci/success", { ci: "succeeded", report: "succeeded" }, null],
    ["reusable-ci/failure", { ci: "failed", report: "succeeded" }, /Stopped in CI \(reusable workflow\): ci \/ unit \(windows\) failed at step “Unit tests”/],
    ["reusable-ci/running", { ci: "running", report: "pending" }, null],
    ["multi-env-cd/success", { dev: "succeeded", test: "succeeded", stage: "succeeded", prod: "succeeded" }, null],
    ["multi-env-cd/running", { dev: "succeeded", test: "running", stage: "pending", prod: "pending" }, null],
    ["multi-env-cd/dev-rolled-back", { dev: "recovered", test: "blocked", stage: "blocked", prod: "blocked" }, /Stopped in Dev: smoke-dev failed at step “Smoke tests”\. Recovery jobs ran and succeeded\. Not run as a result: Test, Stage, Prod\./],
    ["release/ci-failed", { ci: "failed", dev: "blocked", test: "blocked", stage: "blocked", prod: "blocked" }, /Stopped in CI & artifact: ci \/ build failed at step “Build image”/],
    ["release/prod-waiting", { ci: "succeeded", stage: "succeeded", prod: "awaiting-approval" }, /Paused: the prod deployment is awaiting approval \(release-approvers\)/],
    ["approval-gates/stage-pending", { test: "succeeded", stage: "awaiting-approval", prod: "pending" }, /Paused: the stage deployment is awaiting approval/],
    ["approval-gates/stage-approved", { stage: "running", prod: "pending" }, null],
    ["approval-gates/prod-rejected", { stage: "succeeded", prod: "rejected" }, /Stopped: the prod deployment was rejected by release-manager/],
    ["approval-gates/all-approved", { ci: "succeeded", prod: "succeeded" }, null],
    ["failure-rollback/stage-rolled-back", { stage: "recovered", prod: "blocked" }, /Stopped in Stage: canary-stage failed/],
    ["failure-rollback/prod-rollback-failed", { stage: "succeeded", prod: "recovery-failed" }, /A recovery job also failed/],
    ["failure-rollback/test-failed", { test: "recovered", stage: "blocked", prod: "blocked" }, /Stopped in Test: e2e-test failed/],
    ["platform/billing-stage-failed", { stage: "recovered", prod: "blocked" }, /smoke-billing-stage failed/],
    ["platform/prod-rolling-out", { stage: "succeeded", prod: "running" }, null],
  ];
  it.each(cases)("%s", (key, expected, stop) => {
    const { overview, status } = analyse(byKey.get(key)!);
    expect(status).toMatchObject(expected);
    expect(overview.source).toBe("declared");
    if (stop) expect(overview.stop?.text).toMatch(stop);
    else expect(overview.stop).toBeUndefined();
  });

  it("gates come from the approvals and pending-deployments data", () => {
    expect(analyse(byKey.get("approval-gates/prod-rejected")!).overview.phases.find((p) => p.id === "prod")!.gate).toMatchObject({ state: "rejected", by: "release-manager", source: "approvals API" });
    expect(analyse(byKey.get("approval-gates/stage-pending")!).overview.phases.find((p) => p.id === "stage")!.gate).toMatchObject({ state: "pending", reviewers: ["release-approvers"], source: "pending deployments API" });
    expect(analyse(byKey.get("release/success")!).overview.phases.find((p) => p.id === "prod")!.gate).toMatchObject({ state: "approved" });
  });

  it("blocked phases name the phase that blocked them", () => {
    const { overview } = analyse(byKey.get("failure-rollback/test-failed")!);
    expect(overview.phases.find((p) => p.id === "prod")!.blockedBy).toEqual({ phaseId: "test", reason: "Test: failed · rolled back" });
  });

  it("without the phase file, grouping is inferred from environments and labelled as inferred", () => {
    const r = byKey.get("release/success")!;
    const { def, graph } = analyse(r);
    const inferred = buildOverview(graph, def, { manifest: null }) as ReleaseOverview;
    expect(inferred.source).toBe("inferred");
    expect(inferred.sourceNote).toMatch(/inferred from `environment:`/);
    // The reusable CI call gets its own card; the remaining pre-deployment job stays in "Before deployment".
    expect(inferred.phases.map((p) => p.name)).toEqual(["ci", "Before deployment", "dev", "test", "stage", "prod"]);
    // A smoke test declares no environment; it follows the dev deployment (and test's deployment needs it): dev, inferred.
    expect(inferred.nodePhase.get("def:smoke-dev")).toBe("env:dev");
    expect(inferred.environments.get("def:smoke-dev")).toMatchObject({ environment: "dev", provenance: "heuristic", reason: expect.stringContaining("the `test` deployment needs it") });
    // A rollback that nothing else needs stays with the deployment it follows, marked as a heuristic.
    expect(inferred.nodePhase.get("def:rollback-stage")).toBe("env:stage");
    expect(inferred.environments.get("def:rollback-stage")).toMatchObject({ environment: "stage", provenance: "heuristic" });
    expect(inferred.environments.get("def:deploy-stage")).toMatchObject({ environment: "stage", provenance: "declared" });
    expect(inferred.roles.get("def:rollback-stage")).toEqual({ role: "recovery", evidence: "if: failure()" });
  });

  it("no workflow file means no overview", () => {
    const r = byKey.get("release/success")!;
    const graph = buildRunGraph(r.jobs as unknown as Job[], null, { unavailableReason: "403" });
    expect(buildOverview(graph, null, {})).toHaveProperty("unavailable");
  });
});

describe("synthetic logs are shaped like runner logs, so step-to-log mapping works on them", () => {
  const mapped = runs.flatMap((r) =>
    (r.jobs as unknown as Job[])
      .filter((j) => r.logs.has(j.id) && j.steps?.length)
      .map((j) => {
        const scanner = createMarkerScanner();
        for (const line of r.logs.get(j.id)!.trimEnd().split("\n")) scanner.push(line);
        return { run: r, job: j, mapping: mapSteps(j.steps!, scanner.result()) };
      }),
  );

  it("passes every check for every job except rollback jobs (an older runner without composite-action markers)", () => {
    expect(mapped.length).toBeGreaterThan(300);
    const wrong = mapped.filter(({ job, mapping }) => (mapping.mapping === "approximate") !== job.name.startsWith("rollback"));
    expect(wrong.map(({ job, mapping }) => `${job.name}: ${mapping.mapping} ${mapping.issues.join(" ")}`)).toEqual([]);
    expect(mapped.some(({ job }) => job.name.startsWith("rollback"))).toBe(true);
  });

  it("puts each failed step's synthetic error in that step", () => {
    let failed = 0;
    for (const { run, job, mapping } of mapped) {
      for (const s of job.steps!.filter((s) => s.conclusion === "failure")) {
        failed++;
        const where = locateStep(job.steps!, mapping, s.number);
        if (where.kind !== "segment") throw new Error(`${job.name} step ${s.number} not located`);
        const lines = run.logs.get(job.id)!.split("\n");
        expect(lines[where.segment.errorLines[0]! - 1]).toContain(`##[error][synthetic] ${s.name} failed`);
      }
    }
    expect(failed).toBeGreaterThan(5);
  });
});
