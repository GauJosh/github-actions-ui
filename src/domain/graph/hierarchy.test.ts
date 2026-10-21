import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildOverview, type ReleaseOverview } from "../phases/phases";
import type { Job, Step } from "../types";
import type { WorkflowFileRef } from "./build";
import { buildHierarchyGraph, parseUses, resolveCall, treeAt, type WorkflowTree } from "./hierarchy";
import { readWorkflowDefinition, type WorkflowDefinition } from "./workflow-definition";

const SHARED_SHA = "b".repeat(40);
const RUN_SHA = "a".repeat(40);
const def = (yaml: string) => readWorkflowDefinition(parse(yaml)) as WorkflowDefinition;

const CALLER = def(`
jobs:
  ci:
    uses: org/shared/.github/workflows/ci.yml@release/v2
  cd:
    needs: ci
    if: \${{ needs.ci.outputs.category != 'express' }}
    uses: org/shared/.github/workflows/cd.yml@release/v2
    with: { image_tag: "\${{ needs.ci.outputs.image_tag }}" }
`);
const CI = def(`
jobs:
  build:
    name: Build
    steps:
      - uses: actions/checkout@v4
      - { name: Install tools, uses: org/action-setup-tools@v1 }
`);
const CD = def(`
jobs:
  deploy-dev:
    name: DEV
    uses: ./.github/workflows/env.yml
    with: { environment: dev }
  dev-validation:
    name: DEV validation
    needs: deploy-dev
    environment: { name: dev }
    steps: [{ run: echo ok }]
  dev-rollback:
    needs: [deploy-dev, dev-validation]
    if: always() && needs.dev-validation.result == 'failure'
    steps: [{ run: echo rollback }]
  deploy-test:
    name: TEST
    needs: dev-validation
    uses: ./.github/workflows/env.yml
    with: { environment: test }
  test-validation:
    name: TEST validation
    needs: deploy-test
    environment: test
    steps: [{ run: echo ok }]
`);
const ENV = def(`
jobs:
  deploy:
    name: Deploy
    environment: \${{ inputs.environment }}
    steps: [{ name: Run CD policy, uses: org/action-cd-policy@v1 }]
  verify:
    needs: deploy
    steps: [{ run: echo verify }]
`);

const file = (repo: string, path: string, revision: string, source: WorkflowFileRef["source"]): WorkflowFileRef => ({ repo, path, revision, source });
const envTree = (): WorkflowTree => ({ file: file("org/shared", ".github/workflows/env.yml", SHARED_SHA, "caller-commit"), definition: ENV, calls: new Map() });
function tree(overrides: { cd?: WorkflowTree } = {}): WorkflowTree {
  return {
    file: file("acme/app", ".github/workflows/main.yml", RUN_SHA, "run-commit"),
    definition: CALLER,
    calls: new Map([
      ["ci", { file: file("org/shared", ".github/workflows/ci.yml", SHARED_SHA, "referenced-workflows"), definition: CI, calls: new Map() }],
      [
        "cd",
        overrides.cd ?? {
          file: file("org/shared", ".github/workflows/cd.yml", SHARED_SHA, "referenced-workflows"),
          definition: CD,
          calls: new Map([
            ["deploy-dev", envTree()],
            ["deploy-test", envTree()],
          ]),
        },
      ],
    ]),
  };
}

let id = 0;
const job = (name: string, conclusion: string, steps: Partial<Step>[] = []): Job =>
  ({ id: ++id, name, status: "completed", conclusion, started_at: "2026-10-20T10:00:00Z", completed_at: "2026-10-20T10:01:00Z", html_url: null, steps }) as unknown as Job;

const failedRun = () => [
  job("ci / Build", "success"),
  job("cd / DEV / Deploy", "failure", [{ number: 2, name: "Run CD policy", status: "completed", conclusion: "failure" }]),
  job("cd / DEV / verify", "skipped"),
  job("cd / DEV validation", "skipped"),
  job("cd / dev-rollback", "skipped"),
  job("cd / TEST", "skipped"),
  job("cd / TEST validation", "skipped"),
];
const successRun = () => [
  job("ci / Build", "success"),
  job("cd / DEV / Deploy", "success"),
  job("cd / DEV / verify", "success"),
  job("cd / DEV validation", "success"),
  job("cd / dev-rollback", "skipped"),
  job("cd / TEST / Deploy", "success"),
  job("cd / TEST / verify", "success"),
  job("cd / TEST validation", "success"),
];
const edgeList = (edges: { from: string; to: string; via?: string }[]) => edges.map((e) => `${e.from} -> ${e.to}${e.via ? " (call)" : ""}`).sort();

describe("revisions of called workflows", () => {
  const caller = file("acme/app", ".github/workflows/main.yml", RUN_SHA, "run-commit");
  const shared = file("org/shared", ".github/workflows/cd.yml", SHARED_SHA, "referenced-workflows");

  it("parses local and remote references", () => {
    expect(parseUses("./.github/workflows/env.yml")).toEqual({ kind: "local", path: ".github/workflows/env.yml" });
    expect(parseUses("org/shared/.github/workflows/ci.yml@release/v2")).toEqual({ kind: "remote", repo: "org/shared", path: ".github/workflows/ci.yml", ref: "release/v2" });
    expect(parseUses("org/action@v1")).toBeNull();
  });

  it("uses the commit GitHub reported for a branch ref, never the branch itself", () => {
    const referenced = [{ path: "org/shared/.github/workflows/ci.yml@release/v2", sha: SHARED_SHA, ref: "refs/heads/release/v2" }];
    expect(resolveCall("org/shared/.github/workflows/ci.yml@release/v2", caller, referenced)).toEqual({ file: file("org/shared", ".github/workflows/ci.yml", SHARED_SHA, "referenced-workflows") });
    const missing = resolveCall("org/shared/.github/workflows/cd.yml@release/v2", caller, referenced);
    expect(missing).toHaveProperty("unresolved");
    expect((missing as { unresolved: string }).unresolved).toContain("did not report which commit `release/v2`");
  });

  it("uses a pinned SHA as written, and reports conflicting commits as ambiguous", () => {
    expect(resolveCall(`org/shared/.github/workflows/ci.yml@${"c".repeat(40)}`, caller, [])).toEqual({ file: file("org/shared", ".github/workflows/ci.yml", "c".repeat(40), "pinned-sha") });
    const twice = [
      { path: "org/shared/.github/workflows/ci.yml@v2", sha: "c".repeat(40) },
      { path: "org/shared/.github/workflows/ci.yml@v2", sha: "d".repeat(40) },
    ];
    expect(resolveCall("org/shared/.github/workflows/ci.yml@v2", caller, twice)).toHaveProperty("unresolved", expect.stringContaining("ambiguous"));
  });

  it("reads a nested ./ reference from the repository and commit of the workflow that contains it", () => {
    expect(resolveCall("./.github/workflows/env.yml", shared, [])).toEqual({ file: file("org/shared", ".github/workflows/env.yml", SHARED_SHA, "caller-commit") });
    expect(resolveCall("./.github/workflows/build.yml", caller, [])).toEqual({ file: file("acme/app", ".github/workflows/build.yml", RUN_SHA, "run-commit") });
  });
});

describe("execution graph across nested reusable workflows", () => {
  it("expands the deploying call into its jobs, keeps CI as one call, and draws only declared needs", () => {
    const g = buildHierarchyGraph(failedRun(), tree());
    expect(g.nodes.map((n) => n.key).sort()).toEqual(
      ["def:ci", "def:cd/deploy-dev/deploy", "def:cd/deploy-dev/verify", "def:cd/dev-validation", "def:cd/dev-rollback", "def:cd/deploy-test", "def:cd/test-validation"].sort(),
    );
    expect(edgeList(g.edges)).toEqual(
      [
        "def:ci -> def:cd/deploy-dev/deploy (call)", // caller level: cd needs ci
        "def:cd/deploy-dev/deploy -> def:cd/deploy-dev/verify", // inside the environment workflow
        "def:cd/deploy-dev/verify -> def:cd/dev-validation (call)", // cd: dev-validation needs the deploy-dev call
        "def:cd/deploy-dev/verify -> def:cd/dev-rollback (call)",
        "def:cd/dev-validation -> def:cd/dev-rollback",
        "def:cd/dev-validation -> def:cd/deploy-test",
        "def:cd/deploy-test -> def:cd/test-validation",
      ].sort(),
    );
    const ci = g.nodes.find((n) => n.key === "def:ci")!;
    expect(ci).toMatchObject({ kind: "reusable", callId: "ci", resolvedWorkflow: { sha: SHARED_SHA } });
  });

  it("records each job's call context and the revision of every file on the way", () => {
    const g = buildHierarchyGraph(failedRun(), tree());
    const deploy = g.nodes.find((n) => n.key === "def:cd/deploy-dev/deploy")!;
    expect(deploy.context?.labels).toEqual(["cd", "DEV"]);
    expect(deploy.context?.files.map((f) => `${f?.repo}/${f?.path}@${f?.revision.slice(0, 1)} (${f?.source})`)).toEqual([
      "org/shared/.github/workflows/cd.yml@b (referenced-workflows)",
      "org/shared/.github/workflows/env.yml@b (caller-commit)",
    ]);
    expect(deploy.stepDefs?.map((s) => s.name)).toEqual(["Run CD policy"]);
  });

  it("fills environments from the caller's literal input, and keeps declared ones as declared", () => {
    const g = buildHierarchyGraph(failedRun(), tree());
    const n = (k: string) => g.nodes.find((x) => x.key === k)!;
    expect([n("def:cd/deploy-dev/deploy").environment, n("def:cd/deploy-dev/deploy").environmentEvidence]).toEqual(["dev", "input"]);
    expect([n("def:cd/dev-validation").environment, n("def:cd/dev-validation").environmentEvidence]).toEqual(["dev", "declared"]);
    // A call GitHub reported as skipped stays one node, and shows the one environment its file would deploy to.
    expect(n("def:cd/deploy-test")).toMatchObject({ kind: "reusable", status: "skipped", environment: "test", environmentEvidence: "input", callId: "cd/deploy-test" });
    expect(n("def:cd/deploy-test").members[0]!.wholeCall).toBe(true);
  });

  it("keeps two calls of the same reusable workflow apart", () => {
    const g = buildHierarchyGraph(successRun(), tree());
    const deploys = g.nodes.filter((n) => n.yamlId === "deploy");
    expect(deploys.map((n) => [n.key, n.members.map((m) => m.job.name)])).toEqual([
      ["def:cd/deploy-dev/deploy", ["cd / DEV / Deploy"]],
      ["def:cd/deploy-test/deploy", ["cd / TEST / Deploy"]],
    ]);
    expect(deploys.map((n) => n.environment)).toEqual(["dev", "test"]);
  });

  it("groups the release overview by environment, with CI as its own card, without any phase file", () => {
    const g = buildHierarchyGraph(failedRun(), tree());
    const overview = buildOverview(g, CALLER, { manifest: null }) as ReleaseOverview;
    expect(overview.source).toBe("inferred");
    expect(overview.phases.map((p) => [p.name, p.status])).toEqual([
      ["ci", "succeeded"],
      ["dev", "failed"],
      ["test", "blocked"], // downstream (through real needs) of the failed dev phase
    ]);
    expect(overview.phases.find((p) => p.name === "dev")!.nodeKeys.sort()).toEqual(["def:cd/deploy-dev/deploy", "def:cd/deploy-dev/verify", "def:cd/dev-rollback", "def:cd/dev-validation"].sort());
    expect(overview.roles.get("def:cd/dev-rollback")).toEqual({ role: "recovery", evidence: "if: failure()" });
    expect(overview.stop?.text).toContain("Run CD policy");
  });

  it("without a readable called workflow: one node for the call, no invented edges or environments, and the reason", () => {
    const unread: WorkflowTree = { definition: null, unavailable: "GitHub did not report which commit `release/v2` resolved to.", calls: new Map() };
    const g = buildHierarchyGraph(failedRun(), tree({ cd: unread }));
    expect(g.nodes.map((n) => n.key).sort()).toEqual(["def:cd", "def:ci"]);
    expect(edgeList(g.edges)).toEqual(["def:ci -> def:cd"]);
    expect(g.nodes.find((n) => n.key === "def:cd")!.resolvedWorkflow).toBeUndefined();
    expect(g.evidence.notes.join(" ")).toContain("did not report which commit");
    expect(buildOverview(g, CALLER, { manifest: null })).toEqual({ unavailable: expect.stringContaining("some called workflows could not be read") });
  });

  it("partial job lists: a declared job with no job in the run is shown as declared only, never with a status", () => {
    const g = buildHierarchyGraph(
      successRun().filter((j) => j.name !== "cd / DEV validation"),
      tree(),
    );
    expect(g.nodes.find((n) => n.key === "def:cd/dev-validation")).toMatchObject({ declaredOnly: true, status: "not_run", members: [] });
  });

  it("ambiguous names: jobs matching two calls are shown without edges rather than guessed", () => {
    const twin = def(`
jobs:
  a: { name: Deploy, uses: ./.github/workflows/env.yml, with: { environment: dev } }
  b: { name: Deploy, uses: ./.github/workflows/env.yml, with: { environment: test } }
`);
    const t: WorkflowTree = { file: file("acme/app", "main.yml", RUN_SHA, "run-commit"), definition: twin, calls: new Map([["a", envTree()], ["b", envTree()]]) };
    const g = buildHierarchyGraph([job("Deploy / Deploy", "success")], t);
    expect(g.nodes.some((n) => n.key.startsWith("job:") && n.source === "job-name")).toBe(true);
    expect(g.evidence.notes.join(" ")).toContain("matched more than one job definition");
  });

  it("finds a call's tree by its id", () => {
    expect(treeAt(tree(), "cd/deploy-test")?.definition).toBe(ENV);
    expect(treeAt(tree(), "cd/nope")).toBeUndefined();
  });
});
