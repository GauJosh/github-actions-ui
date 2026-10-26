// Recent runs of one workflow, each with the jobs of its own attempt, for the history model. Read-only (GET), at
// most `concurrency` jobs requests at once; a run whose jobs cannot be read is reported and the rest are kept.
import type { HistoryRun } from "../domain/insights/history";
import type { RepoRef, Run } from "../domain/types";
import type { GitHubClient } from "../github/client";

export const HISTORY_LIMITS = { runs: 20, concurrency: 2 };

export type LoadedHistory = {
  /** Earlier runs of the workflow (the selected run excluded), each at the attempt GitHub lists it with. */
  runs: HistoryRun[];
  /** Runs whose jobs could not be read. */
  failed: { runId: number; attempt: number; why: string }[];
  /** How many runs GitHub listed (before the limit). */
  listed: number;
};

type Client = Pick<GitHubClient, "listRuns" | "getJobs">;

export async function loadHistory(client: Client, repo: RepoRef, selected: Run, signal?: AbortSignal, limits = HISTORY_LIMITS): Promise<LoadedHistory> {
  const page = await client.listRuns(repo, selected.workflow_id !== undefined ? { workflowId: selected.workflow_id } : {}, 1, limits.runs + 1);
  // The listing is of the workflow already; the path check keeps a listing without a workflow id honest too.
  const candidates = page.runs.filter((r) => r.id !== selected.id && (selected.workflow_id !== undefined ? r.workflow_id === selected.workflow_id : r.path === selected.path)).slice(0, limits.runs);
  const runs: (HistoryRun | undefined)[] = new Array(candidates.length);
  const failed: LoadedHistory["failed"] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      if (signal?.aborted) return;
      const i = next++;
      const run = candidates[i]!;
      // Each run's jobs come from its own attempt (the one GitHub lists), never from the latest-jobs list.
      const attempt = run.run_attempt;
      try {
        const jobs = await client.getJobs({ ...repo, runId: run.id }, attempt);
        runs[i] = { run, attempt, jobs, graph: null };
      } catch (error) {
        failed.push({ runId: run.id, attempt, why: error instanceof Error ? error.message : "request failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, candidates.length) }, worker));
  return { runs: runs.filter((r): r is HistoryRun => r !== undefined), failed: failed.sort((a, b) => a.runId - b.runId), listed: page.totalCount };
}
