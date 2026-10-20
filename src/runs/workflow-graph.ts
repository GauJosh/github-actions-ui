// Loads the evidence for a run's graph: the workflow file at the run's own commit, parsed on demand.
// The YAML parser is loaded lazily, only when a run's graph is opened.
import { buildRunGraph, type RunGraph } from "../domain/graph/build";
import { readWorkflowDefinition, type WorkflowDefinition } from "../domain/graph/workflow-definition";
import type { Job, RepoRef, Run } from "../domain/types";
import { GitHubError, type GitHubClient } from "../github/client";

export type DefinitionResult = { definition: WorkflowDefinition; file: { path: string; revision: string } } | { unavailableReason: string };

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
  return { definition, file: { path: run.path, revision: run.head_sha } };
}

export function graphFor(run: Run, jobs: Job[], result: DefinitionResult): RunGraph {
  const graph =
    "definition" in result
      ? buildRunGraph(jobs, result.definition, { run, file: result.file })
      : buildRunGraph(jobs, null, { run, unavailableReason: result.unavailableReason });
  if ("definition" in result && run.event === "pull_request_target") {
    graph.evidence.notes.unshift("pull_request_target runs use the base branch's workflow file; the file at the run's commit may differ.");
  }
  return graph;
}
