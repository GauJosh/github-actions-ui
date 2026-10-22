// Environment grouping regressions (SYNTHETIC workflows, shaped like a real promotion pipeline). What went wrong:
//   - two readiness checks with the same display name ("Release check", one before PROD and one before
//     PROD-DR) could not be matched to their definitions, so they were drawn without edges next to DEV;
//   - a change-record job after TEST that STAGE needs was shown "between TEST and STAGE" instead of in TEST.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { WorkflowFileRef } from "../graph/build";
import { buildHierarchyGraph, type WorkflowTree } from "../graph/hierarchy";
import { readWorkflowDefinition, type WorkflowDefinition } from "../graph/workflow-definition";
import type { Job } from "../types";
import { buildOverview, type ReleaseOverview } from "./phases";

const SHA = "a".repeat(40);
const def = (yaml: string) => readWorkflowDefinition(parse(yaml)) as WorkflowDefinition;
const file = (path: string): WorkflowFileRef => ({ repo: "acme/app", path, revision: SHA, source: "run-commit" });
const tree = (definition: WorkflowDefinition, calls: Record<string, WorkflowTree> = {}): WorkflowTree => ({ file: file(".github/workflows/cd.yml"), definition, calls: new Map(Object.entries(calls)) });
let id = 0;
const job = (name: string, conclusion = "success"): Job =>
  ({ id: ++id, name, status: "completed", conclusion, started_at: "2026-10-21T10:00:00Z", completed_at: "2026-10-21T10:01:00Z", html_url: null, steps: [] }) as unknown as Job;
const overviewOf = (jobs: Job[], t: WorkflowTree) => buildOverview(buildHierarchyGraph(jobs, t), t.definition, { manifest: null }) as ReleaseOverview;
const phaseOf = (o: ReleaseOverview, key: string) => o.phases.find((p) => p.id === o.nodePhase.get(key))?.name ?? "(unassigned)";

// The environment workflow, called once per environment.
const ENV = def(`
jobs:
  deploy:
    name: Deploy
    environment: \${{ inputs.environment }}
    steps: [{ run: ./deploy.sh }]
  smoke:
    name: Smoke test
    needs: deploy
    steps: [{ run: ./smoke.sh }]
`);
const envTree = (): WorkflowTree => ({ file: file(".github/workflows/env.yml"), definition: ENV, calls: new Map() });

describe("promotion pipeline: change records and readiness checks (the reported pattern)", () => {
  const CD = def(`
jobs:
  deploy-dev: { name: DEV, uses: ./.github/workflows/env.yml, with: { environment: dev } }
  dev-validation: { name: DEV validation, needs: deploy-dev, environment: dev, steps: [{ run: ./validate.sh }] }
  dev-rollback: { name: DEV rollback, needs: [deploy-dev, dev-validation], if: "always() && needs.dev-validation.result == 'failure'", steps: [{ run: ./rollback.sh }] }
  deploy-test: { name: TEST, needs: dev-validation, uses: ./.github/workflows/env.yml, with: { environment: test } }
  test-validation: { name: TEST validation, needs: deploy-test, environment: test, steps: [{ run: ./validate.sh }] }
  sign-off-test: { needs: test-validation, environment: test, steps: [{ run: ./sign-off.sh }] }
  publish-sign-off-test: { needs: sign-off-test, steps: [{ run: ./publish-sign-off.sh }] }
  deploy-stage: { name: STAGE, needs: publish-sign-off-test, uses: ./.github/workflows/env.yml, with: { environment: stage } }
  stage-validation: { name: STAGE validation, needs: [deploy-stage, publish-sign-off-test], environment: stage, steps: [{ run: ./validate.sh }] }
  gate-prod: { name: Gate PROD, needs: stage-validation, environment: { name: prod }, steps: [{ run: echo waiting }] }
  gate-prod-dr: { name: Gate PROD-DR, needs: stage-validation, environment: { name: prod-dr }, steps: [{ run: echo waiting }] }
  release-check-prod: { name: Release check, needs: [gate-prod, publish-sign-off-test], steps: [{ run: ./verify.sh }] }
  release-check-prod-dr: { name: Release check, needs: [gate-prod-dr, publish-sign-off-test], steps: [{ run: ./verify.sh }] }
  deploy-prod: { name: PROD, needs: [gate-prod, release-check-prod], uses: ./.github/workflows/env.yml, with: { environment: prod } }
  deploy-prod-dr: { name: PROD-DR, needs: [gate-prod-dr, release-check-prod-dr], uses: ./.github/workflows/env.yml, with: { environment: prod-dr } }
`);
  const t = tree(CD, { "deploy-dev": envTree(), "deploy-test": envTree(), "deploy-stage": envTree(), "deploy-prod": envTree(), "deploy-prod-dr": envTree() });
  const names = (verify: [string, string]) => [
    ["DEV / Deploy", "success"],
    ["DEV / Smoke test", "success"],
    ["DEV validation", "success"],
    ["DEV rollback", "skipped"],
    ["TEST / Deploy", "success"],
    ["TEST / Smoke test", "success"],
    ["TEST validation", "success"],
    ["sign-off-test", "success"],
    ["publish-sign-off-test", "success"],
    ["STAGE / Deploy", "success"],
    ["STAGE / Smoke test", "success"],
    ["STAGE validation", "success"],
    ["Gate PROD", "success"],
    ["Gate PROD-DR", "success"],
    ["Release check", verify[0]],
    ["Release check", verify[1]],
    ["PROD", "skipped"],
    ["PROD-DR", "skipped"],
  ];
  const jobs = (verify: [string, string] = ["skipped", "skipped"]) => names(verify).map(([n, c]) => job(n!, c!));

  it("same-name readiness checks with the same result are matched to their definitions and grouped with PROD and PROD-DR", () => {
    const graph = buildHierarchyGraph(jobs(), t);
    const verify = graph.nodes.filter((n) => n.label === "Release check");
    expect(verify.map((n) => [n.key, n.source, n.members.length, n.members[0]?.sameNameAs])).toEqual([
      ["def:release-check-prod", "workflow-file", 1, ["release-check-prod-dr"]],
      ["def:release-check-prod-dr", "workflow-file", 1, ["release-check-prod"]],
    ]);
    expect(graph.evidence.notes.join(" ")).toContain("2 jobs are named “Release check” and had the same result (skipped)");
    const o = buildOverview(graph, CD, { manifest: null }) as ReleaseOverview;
    expect(phaseOf(o, "def:release-check-prod")).toBe("prod");
    expect(phaseOf(o, "def:release-check-prod-dr")).toBe("prod-dr");
    expect(o.environments.get("def:release-check-prod")).toMatchObject({ provenance: "heuristic", reason: expect.stringContaining("“Gate PROD”, which deploys to `prod`") });
  });

  it("a change-record job after TEST that STAGE needs is grouped with TEST, labelled as inferred", () => {
    const o = overviewOf(jobs(), t);
    expect(phaseOf(o, "def:publish-sign-off-test")).toBe("test");
    expect(o.environments.get("def:publish-sign-off-test")).toEqual({
      environment: "test",
      provenance: "heuristic",
      reason: "it declares no environment, and it runs after “sign-off-test”, which deploys to `test`, in the same workflow; the `stage` deployment needs it",
    });
    expect(o.phases.map((p) => p.name)).toEqual(["dev", "test", "stage", "prod", "prod-dr"]);
    expect(o.phases.find((p) => p.name === "dev")!.nodeKeys.sort()).toEqual(["def:deploy-dev/deploy", "def:deploy-dev/smoke", "def:dev-rollback", "def:dev-validation"].sort());
    expect(o.unassignedKeys).toEqual([]);
  });

  it("same-name jobs with different results are not guessed: they stay unmatched, in “Other jobs”, with the reason", () => {
    const graph = buildHierarchyGraph(jobs(["success", "failure"]), t);
    const byName = graph.nodes.filter((n) => n.source === "job-name" && n.label.includes("Release check"));
    expect(byName).toHaveLength(2);
    expect(graph.evidence.notes.join(" ")).toContain("matched more than one job definition");
    const o = buildOverview(graph, CD, { manifest: null }) as ReleaseOverview;
    for (const n of byName) expect(o.unassignedKeys).toContain(n.key);
  });

  it("repeated calls of one workflow keep separate identities and environments", () => {
    const o = overviewOf(jobs(), t);
    // PROD and PROD-DR were skipped, so GitHub reports each call as one job: two nodes, one per call.
    expect(o.environments.get("def:deploy-prod")).toMatchObject({ environment: "prod", provenance: "input" });
    expect(o.environments.get("def:deploy-prod-dr")).toMatchObject({ environment: "prod-dr", provenance: "input" });
    expect(o.environments.get("def:deploy-test/deploy")).toMatchObject({ environment: "test", provenance: "input" });
    expect(o.environments.get("def:deploy-stage/smoke")).toMatchObject({ environment: "stage", provenance: "input", reason: "“STAGE” is called with `environment: stage`" });
    expect(o.environments.get("def:dev-rollback")).toMatchObject({ environment: "dev", provenance: "heuristic" });
  });
});

describe("evidence from reusable-workflow calls", () => {
  // The check sits inside the per-environment workflow, which takes its environment under another input name.
  const ENV2 = def(`
jobs:
  verify: { name: Release check, steps: [{ run: ./check.sh }] }
  deploy:
    name: Deploy
    needs: verify
    environment: \${{ inputs.target_env }}
    steps: [{ run: ./deploy.sh }]
`);
  const env2 = (): WorkflowTree => ({ file: file(".github/workflows/env2.yml"), definition: ENV2, calls: new Map() });
  const CD = def(`
jobs:
  dev: { name: DEV, uses: ./.github/workflows/env2.yml, with: { target_env: dev } }
  prod: { name: PROD, needs: dev, uses: ./.github/workflows/env2.yml, with: { target_env: prod } }
  prod-dr: { name: PROD-DR, needs: dev, uses: ./.github/workflows/env2.yml, with: { target_env: prod-dr } }
`);
  const jobs = () => ["DEV", "PROD", "PROD-DR"].flatMap((c) => [job(`${c} / Release check`), job(`${c} / Deploy`)]);

  it("a job in a call that passes `target_env: prod` belongs to prod, however the input is named; each call keeps its own identity", () => {
    const o = overviewOf(jobs(), tree(CD, { dev: env2(), prod: env2(), "prod-dr": env2() }));
    expect(phaseOf(o, "def:prod/verify")).toBe("prod");
    expect(phaseOf(o, "def:prod-dr/verify")).toBe("prod-dr");
    expect(phaseOf(o, "def:dev/verify")).toBe("dev");
    expect(o.environments.get("def:prod/verify")).toEqual({ environment: "prod", provenance: "input", reason: "“PROD” is called with `target_env: prod`" });
  });

  it("a separate check call that passes the environment's name (any case) is grouped with that environment", () => {
    const CHECKS = def(`
jobs:
  deploy-dev: { name: DEV, environment: dev, steps: [{ run: ./deploy.sh }] }
  ready-prod: { name: Release check, needs: deploy-dev, uses: ./.github/workflows/ready.yml, with: { stage: PROD } }
  deploy-prod: { name: PROD, needs: ready-prod, environment: prod, steps: [{ run: ./deploy.sh }] }
`);
    const READY = def(`jobs: { check: { steps: [{ run: ./check.sh }] } }`);
    const o = overviewOf([job("DEV"), job("Release check / check"), job("PROD")], tree(CHECKS, { "ready-prod": { file: file(".github/workflows/ready.yml"), definition: READY, calls: new Map() } }));
    expect(phaseOf(o, "def:ready-prod")).toBe("prod");
    expect(o.environments.get("def:ready-prod")).toMatchObject({ provenance: "input", reason: "the call is called with `stage: PROD`" });
  });

  it("an input that cannot be resolved is not used; such jobs are labelled unknown, never guessed", () => {
    const CD3 = def(`
jobs:
  plan: { name: Plan, steps: [{ run: ./plan.sh }] }
  dev: { name: DEV, needs: plan, uses: ./.github/workflows/env.yml, with: { environment: dev } }
  next: { name: NEXT, needs: dev, uses: ./.github/workflows/env.yml, with: { environment: "\${{ needs.plan.outputs.target }}" } }
`);
    const graph = buildHierarchyGraph([job("Plan"), job("DEV / Deploy"), job("DEV / Smoke test"), job("NEXT / Deploy"), job("NEXT / Smoke test")], tree(CD3, { dev: envTree(), next: envTree() }));
    const o = buildOverview(graph, CD3, { manifest: null }) as ReleaseOverview;
    expect(phaseOf(o, "def:dev/deploy")).toBe("dev");
    expect(phaseOf(o, "def:plan")).toBe("Before deployment");
    // NEXT's environment is unknown: it is not folded into dev.
    const next = graph.nodes.find((n) => n.key.startsWith("def:next"))!;
    expect(next.environment).toBeUndefined();
    expect(o.nodePhase.get(next.key)).not.toBe("env:dev");
    expect(o.environments.get(next.key)?.provenance).toBe("unknown");
    expect(o.unassignedKeys).toContain(next.key);
  });

  it("a call passing several environment names is ambiguous and says so", () => {
    const MULTI = def(`
jobs:
  dev: { name: DEV, environment: dev, steps: [{ run: ./deploy.sh }] }
  prod: { name: PROD, needs: dev, environment: prod, steps: [{ run: ./deploy.sh }] }
  report: { name: Report, needs: prod, uses: ./.github/workflows/report.yml, with: { from: dev, to: prod } }
`);
    const REPORT = def(`jobs: { send: { steps: [{ run: ./send.sh }] } }`);
    const o = overviewOf([job("DEV"), job("PROD"), job("Report / send")], tree(MULTI, { report: { file: file(".github/workflows/report.yml"), definition: REPORT, calls: new Map() } }));
    expect(o.notes.join(" ")).toContain("passes several environment names (dev, prod)");
    // It still follows prod in the same workflow and nothing else needs it: prod, marked as a heuristic.
    expect(o.environments.get("def:report")).toMatchObject({ environment: "prod", provenance: "heuristic" });
  });
});

describe("unrelated and simple workflows", () => {
  it("a single deployment with checks after it keeps them with it (heuristic, labelled)", () => {
    const SIMPLE = def(`
jobs:
  build: { steps: [{ run: make }] }
  deploy: { needs: build, environment: production, steps: [{ run: ./deploy.sh }] }
  smoke: { needs: deploy, steps: [{ run: ./smoke.sh }] }
`);
    const o = overviewOf([job("build"), job("deploy"), job("smoke")], tree(SIMPLE));
    expect(o.phases.map((p) => [p.name, p.nodeKeys])).toEqual([
      ["Before deployment", ["def:build"]],
      ["production", ["def:deploy", "def:smoke"]],
    ]);
    expect(o.environments.get("def:smoke")).toMatchObject({ environment: "production", provenance: "heuristic" });
    expect(o.environments.get("def:build")).toMatchObject({ provenance: "unknown", reason: "it runs before any deployment" });
  });

  it("a workflow with no environments offers no overview", () => {
    const NONE = def(`jobs: { a: { steps: [{ run: x }] }, b: { needs: a, steps: [{ run: y }] } }`);
    expect(buildOverview(buildHierarchyGraph([job("a"), job("b")], tree(NONE)), NONE, { manifest: null })).toHaveProperty("unavailable");
  });
});
