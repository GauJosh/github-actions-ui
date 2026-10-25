// Loads the evidence for a run's graph: the workflow file at the run's own commit, parsed on demand.
// The YAML parser is loaded lazily, only when a run's graph is opened.
import { buildRunGraph, type RunGraph, type WorkflowFileRef } from "../domain/graph/build";
import { buildHierarchyGraph, type WorkflowTree } from "../domain/graph/hierarchy";
import { readWorkflowDefinition, type WorkflowDefinition } from "../domain/graph/workflow-definition";
import type { Job, RepoRef, Run } from "../domain/types";
import { GitHubError, type GitHubClient } from "../github/client";
import { TREE_LIMITS, type TreeStats } from "./workflow-tree";

/** `text`: the file as read, kept for comparisons between runs. */
export type DefinitionResult = { definition: WorkflowDefinition; file: { path: string; revision: string }; text?: string } | { unavailableReason: string };

export async function loadWorkflowDefinition(client: GitHubClient, repo: RepoRef, run: Run): Promise<DefinitionResult> {
  if (!run.path || !/\.ya?ml$/.test(run.path)) {
    return { unavailableReason: "This run has no workflow file in the repository (for example, a GitHub-managed or dynamic workflow)." };
  }
  let text: string;
  try {
    text = await client.getWorkflowFile(repo, run.path, run.head_sha);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    switch (error.failure.kind) {
      case "permission":
      case "auth-failed":
        return { unavailableReason: "The token cannot read the workflow file (it needs Contents: Read for this repository)." };
      case "not-found-or-no-permission":
        return { unavailableReason: `The workflow file was not found at the run's commit ${run.head_sha.slice(0, 7)}, or the token cannot read it.` };
      case "rate-limited":
        return { unavailableReason: "GitHub's rate limit was reached while reading the workflow file." };
      default:
        return { unavailableReason: "The workflow file could not be read." };
    }
  }
  let doc: unknown;
  try {
    const { parse } = await import("yaml");
    doc = parse(text);
  } catch {
    return { unavailableReason: "The workflow file could not be parsed as YAML." };
  }
  const definition = readWorkflowDefinition(doc);
  if ("error" in definition) return { unavailableReason: definition.error };
  return { definition, file: { path: run.path, revision: run.head_sha }, text };
}

/** The run's own workflow file, as the root of its call hierarchy. */
export const rootFile = (repo: RepoRef, run: Run, result: { file: { path: string; revision: string } }): WorkflowFileRef => ({
  repo: `${repo.owner}/${repo.repo}`,
  path: result.file.path,
  revision: result.file.revision,
  source: "run-commit",
});

/** The run's graph: across its reusable-workflow calls when the hierarchy was loaded (see hierarchy.ts). */
export function graphFor(repo: RepoRef, run: Run, jobs: Job[], result: DefinitionResult, loaded?: { tree: WorkflowTree; stats: TreeStats }): RunGraph {
  if (!("definition" in result)) return buildRunGraph(jobs, null, { run, unavailableReason: result.unavailableReason });
  const tree = loaded?.tree ?? { file: rootFile(repo, run, result), definition: result.definition, calls: new Map() };
  const graph = buildHierarchyGraph(jobs, tree, run);
  if (loaded?.stats.filesRead) {
    graph.evidence.notes.push(
      `${loaded.stats.filesRead} called workflow file${loaded.stats.filesRead === 1 ? " was" : "s were"} read at the revisions this run used (limits: ${TREE_LIMITS.depth} levels, ${TREE_LIMITS.files} files per run).`,
    );
  }
  if ("definition" in result && run.event === "pull_request_target") {
    graph.evidence.notes.unshift("pull_request_target runs use the base branch's workflow file; the file at the run's commit may differ.");
  }
  return graph;
}
