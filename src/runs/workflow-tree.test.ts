import { describe, expect, it } from "vitest";
import type { WorkflowFileRef } from "../domain/graph/build";
import { treeAt } from "../domain/graph/hierarchy";
import { readWorkflowDefinition, type WorkflowDefinition } from "../domain/graph/workflow-definition";
import type { ApiFailure } from "../domain/types";
import { GitHubError, type GitHubClient } from "../github/client";
import { loadWorkflowTree, TREE_LIMITS } from "./workflow-tree";
import { parse } from "yaml";

const SHA = "a".repeat(40);
const ROOT: WorkflowFileRef = { repo: "acme/app", path: ".github/workflows/main.yml", revision: SHA, source: "run-commit" };
const def = (yaml: string) => readWorkflowDefinition(parse(yaml)) as WorkflowDefinition;

/** A fake client serving files by "owner/repo@sha:path"; records every request and the peak concurrency. */
function fakeClient(files: Record<string, string | ApiFailure>) {
  const requests: string[] = [];
  let active = 0;
  let peak = 0;
  const client = {
    async getWorkflowFile(ref: { owner: string; repo: string }, path: string, commit: string) {
      const key = `${ref.owner}/${ref.repo}@${commit}:${path}`;
      requests.push(key);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      const file = files[key];
      if (file === undefined) throw new GitHubError({ kind: "not-found-or-no-permission" });
      if (typeof file !== "string") throw new GitHubError(file);
      return file;
    },
  } as unknown as GitHubClient;
  return { client, requests, peak: () => peak };
}

describe("loading the reusable-workflow hierarchy (bounded, read-only, revision-exact)", () => {
  it("reads called workflows at the reported commits, nested ./ calls at their caller's commit, and each file once", async () => {
    const shared = "b".repeat(40);
    const { client, requests } = fakeClient({
      [`org/shared@${shared}:.github/workflows/cd.yml`]: "jobs:\n  dev: { uses: ./.github/workflows/env.yml, with: { environment: dev } }\n  test: { uses: ./.github/workflows/env.yml, with: { environment: test } }\n",
      [`org/shared@${shared}:.github/workflows/env.yml`]: "jobs:\n  deploy: { environment: '${{ inputs.environment }}', steps: [{ run: x }] }\n",
    });
    const root = def("jobs:\n  cd: { uses: org/shared/.github/workflows/cd.yml@release/v2 }\n");
    const { tree, stats } = await loadWorkflowTree(client, { referenced_workflows: [{ path: "org/shared/.github/workflows/cd.yml@release/v2", sha: shared }] }, { definition: root, file: ROOT });
    expect(treeAt(tree, "cd")?.file).toEqual({ repo: "org/shared", path: ".github/workflows/cd.yml", revision: shared, source: "referenced-workflows" });
    expect(treeAt(tree, "cd/dev")?.file).toEqual({ repo: "org/shared", path: ".github/workflows/env.yml", revision: shared, source: "caller-commit" });
    expect(treeAt(tree, "cd/test")?.definition?.jobs[0]?.id).toBe("deploy");
    // env.yml is called twice but read once (in-session cache); nothing at a branch name is ever requested.
    expect(requests.sort()).toEqual([`org/shared@${shared}:.github/workflows/cd.yml`, `org/shared@${shared}:.github/workflows/env.yml`]);
    expect(stats.filesRead).toBe(2);
  });

  it("does not read a branch or tag GitHub did not resolve, and says why", async () => {
    const { client, requests } = fakeClient({});
    const root = def("jobs:\n  cd: { uses: org/shared/.github/workflows/cd.yml@main }\n");
    const { tree } = await loadWorkflowTree(client, { referenced_workflows: [] }, { definition: root, file: ROOT });
    expect(requests).toEqual([]);
    expect(treeAt(tree, "cd")?.unavailable).toContain("did not report which commit `main`");
  });

  it("stops at the depth limit and detects cycles", async () => {
    // level0 calls level1 ... each a different file in the same repo and commit.
    const files: Record<string, string> = {};
    for (let i = 1; i <= TREE_LIMITS.depth + 3; i++) files[`acme/app@${SHA}:.github/workflows/l${i}.yml`] = `jobs:\n  next: { uses: ./.github/workflows/l${i + 1}.yml }\n`;
    files[`acme/app@${SHA}:.github/workflows/loop.yml`] = "jobs:\n  again: { uses: ./.github/workflows/loop.yml }\n";
    const { client, requests } = fakeClient(files);
    const root = def("jobs:\n  next: { uses: ./.github/workflows/l1.yml }\n  loop: { uses: ./.github/workflows/loop.yml }\n");
    const { tree, stats } = await loadWorkflowTree(client, {}, { definition: root, file: ROOT });
    const deepest = treeAt(tree, Array(TREE_LIMITS.depth + 1).fill("next").join("/"));
    expect(deepest?.unavailable).toBe(`Not read: more than ${TREE_LIMITS.depth} levels of nested calls.`);
    expect(stats.limitsReached).toContain("depth");
    expect(treeAt(tree, "loop/again")?.unavailable).toContain("calls itself");
    expect(requests.filter((r) => r.endsWith("loop.yml"))).toHaveLength(1);
    expect(requests.length).toBe(TREE_LIMITS.depth + 1);
  });

  it("reads at most the file budget, with at most the configured concurrency", async () => {
    const files: Record<string, string> = {};
    const jobs: string[] = [];
    for (let i = 0; i < TREE_LIMITS.files + 15; i++) {
      files[`acme/app@${SHA}:.github/workflows/w${i}.yml`] = "jobs:\n  a: { steps: [{ run: x }] }\n";
      jobs.push(`  c${i}: { uses: ./.github/workflows/w${i}.yml }`);
    }
    const { client, requests, peak } = fakeClient(files);
    const { tree, stats } = await loadWorkflowTree(client, {}, { definition: def(`jobs:\n${jobs.join("\n")}\n`), file: ROOT });
    expect(requests).toHaveLength(TREE_LIMITS.files);
    expect(peak()).toBeLessThanOrEqual(TREE_LIMITS.concurrency);
    expect(treeAt(tree, `c${TREE_LIMITS.files + 1}`)?.unavailable).toContain(`more than ${TREE_LIMITS.files} workflow files`);
    expect(stats.limitsReached).toEqual(["files"]);
  });

  it("reports permission failures per file and stops reading after a rate limit, without guessing", async () => {
    const { client, requests } = fakeClient({
      [`acme/app@${SHA}:.github/workflows/a.yml`]: { kind: "permission" } as ApiFailure,
      [`acme/app@${SHA}:.github/workflows/b.yml`]: { kind: "rate-limited", resetAt: 0 } as unknown as ApiFailure,
    });
    const root = def("jobs:\n  a: { uses: ./.github/workflows/a.yml }\n  b: { uses: ./.github/workflows/b.yml }\n  c: { uses: ./.github/workflows/c.yml }\n");
    const { tree } = await loadWorkflowTree(client, {}, { definition: root, file: ROOT });
    expect(treeAt(tree, "a")?.unavailable).toContain("cannot read acme/app/.github/workflows/a.yml");
    expect(treeAt(tree, "b")?.unavailable).toContain("rate limit");
    expect(treeAt(tree, "a")?.definition).toBeNull();
    expect(requests.length).toBeLessThanOrEqual(3);
  });
});
