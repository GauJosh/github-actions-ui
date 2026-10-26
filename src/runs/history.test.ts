// Loading run history (SYNTHETIC runs and jobs): attempts, concurrency, partial failure and cancellation.
import { describe, expect, it } from "vitest";
import { compareToBaseline } from "../domain/insights/history";
import type { Job, Run } from "../domain/types";
import { loadHistory } from "./history";

const repo = { owner: "o", repo: "r" };
const run = (id: number, extra: Partial<Run> = {}): Run =>
  ({ id, name: "ci", display_title: "ci", status: "completed", conclusion: "success", run_attempt: 1, head_branch: "main", head_sha: "a".repeat(40), html_url: "", event: "push", path: ".github/workflows/ci.yml", workflow_id: 7, run_started_at: new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString(), ...extra }) as Run;
const job = (id: number, attempt: number): Job =>
  ({ id, name: "build", status: "completed", conclusion: "success", started_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:01:00Z", html_url: null, run_attempt: attempt }) as Job;

function fakeClient(runs: Run[], opts: { fail?: Set<number>; delay?: number } = {}) {
  const calls: { runId: number; attempt?: number }[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const client = {
    listRuns: async () => ({ runs, totalCount: runs.length, hasNext: false }),
    getJobs: async (ref: { runId: number }, attempt?: number) => {
      calls.push({ runId: ref.runId, attempt });
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, opts.delay ?? 1));
      inflight--;
      if (opts.fail?.has(ref.runId)) throw new Error("GitHub request failed: http-error");
      return [job(ref.runId * 10 + (attempt ?? 0), attempt ?? 0)];
    },
  };
  return { client, calls, max: () => maxInflight };
}

describe("loading run history", () => {
  it("reads each run's jobs at the attempt GitHub lists it with, and leaves out the selected run and other workflows", async () => {
    const selected = run(10, { run_attempt: 2 });
    const runs = [selected, run(9, { run_attempt: 3 }), run(8), run(7, { workflow_id: 99 })];
    const { client, calls } = fakeClient(runs);
    const h = await loadHistory(client, repo, selected);
    expect(calls.sort((a, b) => a.runId - b.runId)).toEqual([
      { runId: 8, attempt: 1 },
      { runId: 9, attempt: 3 },
    ]);
    expect(h.runs.map((r) => [r.run.id, r.attempt, r.jobs.map((j) => j.run_attempt)])).toEqual([
      [9, 3, [3]],
      [8, 1, [1]],
    ]);
  });

  it("never has more than two jobs requests in flight, and stops at 20 runs", async () => {
    const runs = Array.from({ length: 30 }, (_, i) => run(100 + i));
    const { client, calls, max } = fakeClient(runs, { delay: 5 });
    const h = await loadHistory(client, repo, run(1));
    expect(max()).toBe(2);
    expect(calls).toHaveLength(20);
    expect(h.runs).toHaveLength(20);
  });

  it("keeps the usable history when one run's jobs cannot be read, and reports that run", async () => {
    const runs = [run(3), run(4), run(5)];
    const { client } = fakeClient(runs, { fail: new Set([4]) });
    const h = await loadHistory(client, repo, run(9));
    expect(h.runs.map((r) => r.run.id)).toEqual([3, 5]);
    expect(h.failed).toEqual([{ runId: 4, attempt: 1, why: "GitHub request failed: http-error" }]);
  });

  it("starts no further jobs requests once cancelled", async () => {
    const runs = Array.from({ length: 10 }, (_, i) => run(100 + i));
    const { client, calls } = fakeClient(runs, { delay: 5 });
    const ac = new AbortController();
    const pending = loadHistory(client, repo, run(1), ac.signal);
    ac.abort();
    await pending;
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("with too few usable runs, the baseline says so instead of comparing", async () => {
    const selected = run(9);
    const { client } = fakeClient([run(3), run(4)], { fail: new Set([4]) });
    const h = await loadHistory(client, repo, selected);
    const b = compareToBaseline({ run: selected, attempt: 1, jobs: [job(1, 1)], graph: null }, h.runs);
    expect(b).toMatchObject({ kind: "insufficient", samples: 1, needed: 5 });
  });
});
