// Every attempt of one run, each with its own jobs, for the retry evidence model (domain/insights/retry-evidence.ts).
// Read-only (GET): the run (`…/runs/{id}`) tells how many attempts there are, unless the caller already holds it;
// then, per attempt, the attempt itself (`…/runs/{id}/attempts/{n}`) and its jobs (`…/attempts/{n}/jobs`, at most
// the client's page limit). No logs, artifacts, deployments or releases.
//
// Rules:
// - an attempt is used only when GitHub returns that run and that attempt; otherwise it is reported as not read,
//   with the reason (the run view's AttemptMismatchError message for another attempt). Nothing stands in for it;
// - an attempt whose run or jobs could not be read is reported, never left out silently or counted as a success;
// - at most `attempts` attempts are read, the latest ones; earlier attempts beyond the limit are reported as not read;
// - at most `concurrency` attempts are read at once, each with one request in flight;
// - the abort signal is checked before every request; a cancelled load returns `cancelled: true` and nothing else,
//   so a partial result is never shown;
// - a failure to read the run itself (how many attempts there are) fails the whole load.
import type { RunGraph } from "../domain/graph/build";
import type { AttemptJobs, HistoryInput, RetryInput } from "../domain/insights/retry-evidence";
import type { Job, Run, RunRef } from "../domain/types";
import { AttemptMismatchError, type GitHubClient } from "../github/client";

export const ATTEMPT_LIMITS = { attempts: 10, concurrency: 2 };

export type LoadedAttempt = { attempt: number; run: Run; jobs: Job[] };

export type LoadedAttempts =
  | {
      cancelled: false;
      runId: number;
      /** The run's latest attempt number when the load started. */
      latestAttempt: number;
      /** Attempts read, ascending. */
      attempts: LoadedAttempt[];
      /** Attempts not read, with the reason, ascending. */
      unread: { attempt: number; why: string }[];
    }
  /** Stopped by the abort signal: nothing may be shown. */
  | { cancelled: true };

/** GitHub's answer for the run could not tell how many attempts it has. */
export class AttemptDiscoveryError extends Error {}

type Client = Pick<GitHubClient, "getRun" | "getJobs">;

const reason = (error: unknown) => (error instanceof Error ? error.message : "request failed");

export async function loadAttempts(client: Client, ref: RunRef, known?: Run, signal?: AbortSignal, limits = ATTEMPT_LIMITS): Promise<LoadedAttempts> {
  if (signal?.aborted) return { cancelled: true };
  const latest = known ?? (await client.getRun(ref));
  if (signal?.aborted) return { cancelled: true };
  if (latest.id !== ref.runId) throw new AttemptDiscoveryError(`GitHub returned run ${latest.id} when run ${ref.runId} was requested, so its attempts are not known.`);
  const latestAttempt = latest.run_attempt;
  if (!Number.isInteger(latestAttempt) || latestAttempt < 1) throw new AttemptDiscoveryError("GitHub did not report how many attempts the run has.");

  const first = Math.max(1, latestAttempt - limits.attempts + 1);
  const unread: { attempt: number; why: string }[] = [];
  for (let n = 1; n < first; n++) unread.push({ attempt: n, why: `not loaded: only the latest ${limits.attempts} attempts are read` });
  const todo = Array.from({ length: latestAttempt - first + 1 }, (_, i) => first + i);
  const attempts: LoadedAttempt[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (signal?.aborted) return;
      const n = todo[next++]!;
      try {
        const run = await client.getRun(ref, n);
        if (run.id !== ref.runId) throw new Error(`GitHub returned run ${run.id} when attempt ${n} of run ${ref.runId} was requested.`);
        if (run.run_attempt !== n) throw new AttemptMismatchError(n, run.run_attempt);
        if (signal?.aborted) return;
        const jobs = await client.getJobs(ref, n);
        attempts.push({ attempt: n, run, jobs });
      } catch (error) {
        unread.push({ attempt: n, why: reason(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, todo.length) }, worker));
  if (signal?.aborted) return { cancelled: true };
  return {
    cancelled: false,
    runId: ref.runId,
    latestAttempt,
    attempts: attempts.sort((a, b) => a.attempt - b.attempt),
    unread: unread.sort((a, b) => a.attempt - b.attempt),
  };
}

/**
 * The retry evidence model's input from a completed load. The graph of each attempt (for workflow identity) comes
 * from the caller; without it jobs are matched by name, as the model says.
 */
export function retryInput(loaded: Extract<LoadedAttempts, { cancelled: false }>, options: { history?: HistoryInput | null; graphOf?: (a: LoadedAttempt) => RunGraph | null } = {}): RetryInput {
  const attempts: AttemptJobs[] = loaded.attempts.map((a) => ({ attempt: a.attempt, run: a.run, jobs: a.jobs, graph: options.graphOf?.(a) ?? null }));
  return { runId: loaded.runId, latestAttempt: loaded.latestAttempt, attempts, unread: loaded.unread, ...(options.history !== undefined && { history: options.history }) };
}
