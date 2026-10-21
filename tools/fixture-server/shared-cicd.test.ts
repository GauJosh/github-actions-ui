// The SYNTHETIC "shared CI/CD" scenario through the same pipeline the app uses in live mode: the bounded
// hierarchy loader (reading files the way the Contents API serves them), the hierarchy graph and the overview.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildHierarchyGraph, treeAt } from "../../src/domain/graph/hierarchy";
import { readWorkflowDefinition, type WorkflowDefinition } from "../../src/domain/graph/workflow-definition";
import { buildOverview, gatesFor, type ReleaseOverview } from "../../src/domain/phases/phases";
import type { Job, Run } from "../../src/domain/types";
import { GitHubError, type GitHubClient } from "../../src/github/client";
import { toApprovalRecords } from "../../src/runs/release";
import { loadWorkflowTree } from "../../src/runs/workflow-tree";
import { ENTERPRISE_OWNER, ENTERPRISE_REPO, enterpriseRuns, type EnterpriseRun } from "./enterprise.ts";

const runs = new Map(enterpriseRuns().filter((r) => r.scenario.id === "shared-cicd").map((r) => [r.variant.id, r]));

/** Serves files as the fixture API does: the run's repository at its commit, other repositories from `external`. */
function clientFor(r: EnterpriseRun, requests: string[]): GitHubClient {
  return {
    async getWorkflowFile(ref: { owner: string; repo: string }, path: string, commit: string) {
      requests.push(`${ref.owner}/${ref.repo}@${commit.slice(0, 7)}:${path}`);
      const own = ref.owner === ENTERPRISE_OWNER && ref.repo === ENTERPRISE_REPO && commit === r.run.head_sha ? r.files.get(path) : undefined;
      const file = own ?? r.external.get(`${ref.owner}/${ref.repo}@${commit}`)?.get(path);
      if (file === undefined) throw new GitHubError({ kind: "not-found-or-no-permission" });
      if (typeof file !== "string") throw new GitHubError({ kind: "permission", detail: file.message });
      return file;
    },
  } as unknown as GitHubClient;
}

async function analyse(variant: string) {
  const r = runs.get(variant)!;
  const requests: string[] = [];
  const definition = readWorkflowDefinition(parse(r.files.get(r.run.path)!)) as WorkflowDefinition;
  const run = r.run as unknown as Run;
  const { tree, stats } = await loadWorkflowTree(clientFor(r, requests), run, {
    definition,
    file: { repo: `${ENTERPRISE_OWNER}/${ENTERPRISE_REPO}`, path: r.run.path, revision: r.run.head_sha, source: "run-commit" },
  });
  const jobs = r.jobs as unknown as Job[];
  const graph = buildHierarchyGraph(jobs, tree, run);
  const gates = gatesFor(graph, toApprovalRecords(r.approvals), null);
  const overview = buildOverview(graph, definition, { manifest: null, gates });
  return { r, tree, stats, graph, overview, requests, jobs };
}
const phases = (o: ReturnType<typeof buildOverview>) => ("unavailable" in o ? o : (o as ReleaseOverview).phases.map((p) => `${p.name}: ${p.status}`));

describe("shared CI/CD workflows without a phase file (synthetic)", () => {
  it("reads each workflow once, at the commit GitHub reported, including the nested environment workflow", async () => {
    const { tree, stats, requests } = await analyse("released");
    const shared = treeAt(tree, "cd")!.file!;
    expect(shared).toMatchObject({ repo: "fixtures/shared-workflows", path: ".github/workflows/cd-deploy.yml", source: "referenced-workflows" });
    expect(treeAt(tree, "cd/deploy-prod")!.file).toMatchObject({ repo: "fixtures/shared-workflows", revision: shared.revision, source: "caller-commit" });
    expect(stats.filesRead).toBe(3);
    expect(requests).toHaveLength(3); // the environment workflow is called four times but read once
    expect(requests.every((q) => !q.includes("release/v2"))).toBe(true); // never the branch name
  });

  it("released: CI is one card, then one card per environment, all from the call hierarchy", async () => {
    const { graph, overview } = await analyse("released");
    expect(phases(overview)).toEqual(["ci: succeeded", "dev: succeeded", "test: succeeded", "stage: succeeded", "prod: succeeded"]);
    expect((overview as ReleaseOverview).source).toBe("inferred");
    // CD's jobs are expanded; the four calls of the same environment workflow stay distinct.
    const deploys = graph.nodes.filter((n) => n.yamlId === "deploy");
    expect(deploys.map((n) => `${n.key} ${n.environment} (${n.environmentEvidence})`)).toEqual([
      "def:cd/deploy-dev/deploy dev (input)",
      "def:cd/deploy-test/deploy test (input)",
      "def:cd/deploy-stage/deploy stage (input)",
      "def:cd/deploy-prod/deploy prod (input)",
    ]);
    expect(graph.nodes.find((n) => n.key === "def:ci")).toMatchObject({ kind: "reusable", callId: "ci" });
    // Every edge is a declared needs: inside a file, or a caller-level needs between calls (marked).
    expect(graph.edges.filter((e) => e.via === "call").map((e) => `${e.from} -> ${e.to}`)).toContain("def:ci -> def:cd/deploy-dev/deploy");
    expect(graph.edges.some((e) => e.from === "def:cd/deploy-dev/deploy" && e.to === "def:cd/deploy-dev/smoke" && !e.via)).toBe(true);
    expect((overview as ReleaseOverview).gates.get("prod")).toMatchObject({ state: "approved", source: "approvals API" });
  });

  it("CD policy failure: CI succeeded, DEV failed at its step and rolled back, later environments did not progress", async () => {
    const { graph, overview, jobs } = await analyse("cd-policy-failed");
    expect(phases(overview)).toEqual(["ci: succeeded", "dev: recovered", "test: blocked", "stage: blocked", "prod: blocked"]);
    const o = overview as ReleaseOverview;
    expect(o.stop?.text).toContain("Run CD policy");
    expect(o.roles.get("def:cd/dev-rollback")).toEqual({ role: "recovery", evidence: "if: failure()" });
    // GitHub reports a call that did not run as one skipped job; it is not shown as failed.
    const test = graph.nodes.find((n) => n.key === "def:cd/deploy-test")!;
    expect(test).toMatchObject({ status: "skipped", environment: "test" });
    expect(jobs.find((j) => j.name === "cd / TEST")).toMatchObject({ conclusion: "skipped" });
    expect(jobs.some((j) => j.name.startsWith("cd / TEST / "))).toBe(false);
    expect(graph.nodes.filter((n) => n.status === "failure").map((n) => n.key)).toEqual(["def:cd/deploy-dev/deploy"]);
  });

  it("revision not reported for a branch ref: the CD file is not read, the call stays one node, and the overview says why", async () => {
    const { graph, overview, requests } = await analyse("revision-unresolved");
    expect(requests.some((q) => q.includes("cd-deploy.yml"))).toBe(false);
    const cd = graph.nodes.find((n) => n.key === "def:cd")!;
    expect(cd.callUnavailable).toContain("did not report which commit `release/v2`");
    expect(cd.members.length).toBeGreaterThan(10);
    expect(graph.edges.map((e) => `${e.from} -> ${e.to}`)).toEqual(["def:ci -> def:cd"]);
    expect(overview).toEqual({ unavailable: expect.stringContaining("some called workflows could not be read") });
  });

  it("nested workflow missing: DEV…PROD still come from declared environments; the deploy jobs are shown without invented edges", async () => {
    const { graph, overview } = await analyse("nested-file-missing");
    expect(phases(overview)).toEqual(["ci: succeeded", "dev: succeeded", "test: succeeded", "stage: succeeded", "prod: succeeded"]);
    const inner = graph.nodes.filter((n) => n.context?.path.join("/") === "cd/deploy-dev");
    expect(inner.map((n) => n.label).sort()).toEqual(["Deploy", "Smoke test"]);
    expect(inner.every((n) => n.source === "job-name" && !n.environment)).toBe(true);
    expect(graph.edges.some((e) => inner.some((n) => n.key === e.from) && inner.some((n) => n.key === e.to))).toBe(false);
    expect(graph.evidence.notes.join(" ")).toContain("deploy-environment.yml was not found");
  });

  it("no access to the shared repository: both calls stay single nodes with the permission reason; nothing is guessed", async () => {
    const { graph, overview } = await analyse("no-access");
    expect(graph.nodes.map((n) => n.key).sort()).toEqual(["def:cd", "def:ci"]);
    expect(graph.nodes.every((n) => n.callUnavailable?.includes("cannot read fixtures/shared-workflows"))).toBe(true);
    expect(overview).toHaveProperty("unavailable");
  });
});
