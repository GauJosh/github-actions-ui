// Environment grouping regressions (SYNTHETIC workflows). The pattern that was mis-grouped: promotion checks named
// "Verify Ready to Implement", one before PROD and one before PROD-DR, that declare no environment and need DEV's
// validation. They were put in DEV because DEV was their nearest upstream deployment.
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

describe("promotion checks between environments (the reported pattern)", () => {
  const CD = def(`
jobs:
  deploy-dev: { name: DEV, uses: ./.github/workflows/env.yml, with: { environment: dev } }
  dev-validation: { name: DEV validation, needs: deploy-dev, environment: dev, steps: [{ run: ./validate.sh }] }
  dev-rollback:
    name: DEV rollback
    needs: [deploy-dev, dev-validation]
    if: always() && needs.dev-validation.result == 'failure'
    steps: [{ run: ./rollback.sh }]
  verify-prod: { name: Verify Ready to Implement, needs: dev-validation, steps: [{ run: ./check-ticket.sh }] }
  verify-prod-dr: { name: Verify Ready to Implement, needs: dev-validation, steps: [{ run: ./check-ticket.sh }] }
  deploy-prod: { name: PROD, needs: verify-prod, uses: ./.github/workflows/env.yml, with: { environment: prod } }
  deploy-prod-dr: { name: PROD-DR, needs: verify-prod-dr, uses: ./.github/workflows/env.yml, with: { environment: prod-dr } }
  prod-validation: { name: PROD validation, needs: deploy-prod, environment: prod, steps: [{ run: ./validate.sh }] }
  prod-dr-validation: { name: PROD-DR validation, needs: deploy-prod-dr, environment: prod-dr, steps: [{ run: ./validate.sh }] }
`);
  const t = tree(CD, { "deploy-dev": envTree(), "deploy-prod": envTree(), "deploy-prod-dr": envTree() });
  const jobs = () =>
    ["DEV / Deploy", "DEV / Smoke test", "DEV validation", "DEV rollback", "Verify Ready to Implement", "Verify Ready to Implement", "PROD / Deploy", "PROD / Smoke test", "PROD validation", "PROD-DR / Deploy", "PROD-DR / Smoke test", "PROD-DR validation"].map(
      (n) => job(n, n === "DEV rollback" ? "skipped" : "success"),
    );

  it("does not put a check that a PROD deployment needs into DEV; it is shown between the two, with the reason", () => {
    // Two jobs share the display name, so the run's jobs cannot be told apart by name; the workflow file still
    // defines each one, so both appear (declared-only) and are grouped by their own evidence.
    const o = overviewOf(jobs(), t);
    expect(phaseOf(o, "def:verify-prod")).toBe("Between dev and prod");
    expect(phaseOf(o, "def:verify-prod-dr")).toBe("Between dev and prod-dr");
    expect(o.phases.find((p) => p.name === "dev")!.nodeKeys).not.toContain("def:verify-prod");
    expect(o.environments.get("def:verify-prod")).toMatchObject({ provenance: "unknown", reason: expect.stringContaining("the `prod` deployment needs it") });
  });

  it("groups each environment's jobs together, with provenance, and keeps repeated calls apart", () => {
    const o = overviewOf(jobs(), t);
    expect(o.phases.map((p) => p.name)).toEqual(["dev", "Between dev and prod", "Between dev and prod-dr", "prod", "prod-dr"]);
    const dev = o.phases.find((p) => p.name === "dev")!.nodeKeys.sort();
    expect(dev).toEqual(["def:deploy-dev/deploy", "def:deploy-dev/smoke", "def:dev-rollback", "def:dev-validation"].sort());
    expect(o.phases.find((p) => p.name === "prod")!.nodeKeys.sort()).toEqual(["def:deploy-prod/deploy", "def:deploy-prod/smoke", "def:prod-validation"].sort());
    expect(o.phases.find((p) => p.name === "prod-dr")!.nodeKeys.sort()).toEqual(["def:deploy-prod-dr/deploy", "def:deploy-prod-dr/smoke", "def:prod-dr-validation"].sort());
    expect(o.environments.get("def:deploy-prod/deploy")).toMatchObject({ environment: "prod", provenance: "input" });
    expect(o.environments.get("def:prod-validation")).toMatchObject({ environment: "prod", provenance: "declared" });
    expect(o.environments.get("def:deploy-prod/smoke")).toMatchObject({ environment: "prod", provenance: "input", reason: "“PROD” is called with `environment: prod`" });
    expect(o.environments.get("def:dev-rollback")).toMatchObject({ environment: "dev", provenance: "heuristic" });
  });
});

describe("evidence from reusable-workflow calls", () => {
  // The check sits inside the per-environment workflow, which takes its environment under another input name.
  const ENV2 = def(`
jobs:
  verify: { name: Verify Ready to Implement, steps: [{ run: ./check-ticket.sh }] }
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
  const jobs = () => ["DEV", "PROD", "PROD-DR"].flatMap((c) => [job(`${c} / Verify Ready to Implement`), job(`${c} / Deploy`)]);

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
  ready-prod: { name: Verify Ready to Implement, needs: deploy-dev, uses: ./.github/workflows/ready.yml, with: { stage: PROD } }
  deploy-prod: { name: PROD, needs: ready-prod, environment: prod, steps: [{ run: ./deploy.sh }] }
`);
    const READY = def(`jobs: { check: { steps: [{ run: ./check.sh }] } }`);
    const o = overviewOf([job("DEV"), job("Verify Ready to Implement / check"), job("PROD")], tree(CHECKS, { "ready-prod": { file: file(".github/workflows/ready.yml"), definition: READY, calls: new Map() } }));
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
