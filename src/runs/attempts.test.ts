// Loading every attempt of a run (SYNTHETIC runs and jobs): verification, partial failure, limits and cancellation.
import { describe, expect, it } from "vitest";
import { retryEvidence } from "../domain/insights/retry-evidence";
import type { Job, Run } from "../domain/types";
import { createGitHubClient, GitHubError } from "../github/client";
import type { Transport, TransportRequest } from "../github/transport";
import { AttemptDiscoveryError, loadAttempts, retryInput, type LoadedAttempts } from "./attempts";

const ref = { owner: "o", repo: "r", runId: 70 };
const run = (attempt: number, extra: Partial<Run> = {}): Run =>
  ({ id: 70, name: "ci", display_title: "ci", status: "completed", conclusion: "failure", run_attempt: attempt, head_branch: "main", head_sha: "a".repeat(40), html_url: "", event: "push", path: ".github/workflows/ci.yml", workflow_id: 7, ...extra }) as Run;
const job = (id: number, conclusion: string, runAttempt: number): Job =>
  ({ id, name: "lint", status: "completed", conclusion, started_at: "2026-10-27T10:00:00Z", completed_at: "2026-10-27T10:01:00Z", html_url: null, run_attempt: runAttempt }) as Job;

type Call = { method: "getRun" | "getJobs"; attempt?: number };
/** A fake client: attempt n's run and jobs, with per-attempt failures, wrong answers and delays. */
function fakeClient(
  latest: number,
  opts: {
    runOf?: (n: number) => Run;
    jobsOf?: (n: number) => Job[];
    failRun?: Set<number>;
    failJobs?: Set<number>;
    delay?: (call: Call) => number;
    onCall?: (call: Call) => void;
  } = {},
) {
  const calls: Call[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const track = async <T,>(call: Call, fn: () => T): Promise<T> => {
    calls.push(call);
    opts.onCall?.(call);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, opts.delay?.(call) ?? 1));
    inflight--;
    return fn();
  };
  const client = {
    getRun: (_r: typeof ref, attempt?: number) =>
      track({ method: "getRun", attempt }, () => {
        if (attempt === undefined) return run(latest);
        if (opts.failRun?.has(attempt)) throw new GitHubError({ kind: "http-error", status: 502 });
        return opts.runOf ? opts.runOf(attempt) : run(attempt);
      }),
    getJobs: (_r: typeof ref, attempt?: number) =>
      track({ method: "getJobs", attempt }, () => {
        if (attempt !== undefined && opts.failJobs?.has(attempt)) throw new GitHubError({ kind: "network" });
        return opts.jobsOf ? opts.jobsOf(attempt!) : [job(attempt! * 100, attempt === latest ? "success" : "failure", attempt!)];
      }),
  };
  return { client, calls, max: () => maxInflight };
}
const done = (l: LoadedAttempts) => {
  if (l.cancelled) throw new Error("unexpectedly cancelled");
  return l;
};

describe("loading every attempt of a run", () => {
  it("reads the run, then each attempt and its jobs; nothing else", async () => {
    const { client, calls } = fakeClient(3);
    const l = done(await loadAttempts(client, ref));
    expect(l).toMatchObject({ runId: 70, latestAttempt: 3, unread: [] });
    expect(l.attempts.map((a) => [a.attempt, a.run.run_attempt, a.jobs.map((j) => [j.id, j.conclusion, j.run_attempt])])).toEqual([
      [1, 1, [[100, "failure", 1]]],
      [2, 2, [[200, "failure", 2]]],
      [3, 3, [[300, "success", 3]]],
    ]);
    expect(calls[0]).toEqual({ method: "getRun", attempt: undefined });
    expect(calls.slice(1).sort((a, b) => a.attempt! - b.attempt! || a.method.localeCompare(b.method))).toEqual([
      { method: "getJobs", attempt: 1 },
      { method: "getRun", attempt: 1 },
      { method: "getJobs", attempt: 2 },
      { method: "getRun", attempt: 2 },
      { method: "getJobs", attempt: 3 },
      { method: "getRun", attempt: 3 },
    ]);
  });

  it("uses the run the caller already holds instead of reading it again", async () => {
    const { client, calls } = fakeClient(2);
    const l = done(await loadAttempts(client, ref, run(2)));
    expect(l.latestAttempt).toBe(2);
    expect(calls.filter((c) => c.attempt === undefined)).toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it("an attempt that cannot be read is reported, and the others are kept", async () => {
    const runFails = done(await loadAttempts(fakeClient(3, { failRun: new Set([1]) }).client, ref));
    expect(runFails.attempts.map((a) => a.attempt)).toEqual([2, 3]);
    expect(runFails.unread).toEqual([{ attempt: 1, why: "GitHub request failed: http-error" }]);

    const { client, calls } = fakeClient(3, { failJobs: new Set([2]) });
    const jobsFail = done(await loadAttempts(client, ref));
    expect(jobsFail.attempts.map((a) => a.attempt)).toEqual([1, 3]);
    expect(jobsFail.unread).toEqual([{ attempt: 2, why: "GitHub request failed: network" }]);
    // No retry: one jobs request per attempt.
    expect(calls.filter((c) => c.method === "getJobs" && c.attempt === 2)).toHaveLength(1);
  });

  it("GitHub answering with another attempt is not used as the requested one, and its jobs are not read", async () => {
    const { client, calls } = fakeClient(2, { runOf: (n) => run(n === 1 ? 2 : n) });
    const l = done(await loadAttempts(client, ref));
    expect(l.attempts.map((a) => a.attempt)).toEqual([2]);
    expect(l.unread).toEqual([{ attempt: 1, why: "GitHub returned attempt 2 when attempt 1 was requested, so it is not shown as attempt 1. Try again, or choose another attempt." }]);
    expect(calls.some((c) => c.method === "getJobs" && c.attempt === 1)).toBe(false);
  });

  it("GitHub answering an attempt with another run is not used", async () => {
    const l = done(await loadAttempts(fakeClient(2, { runOf: (n) => run(n, n === 2 ? { id: 71 } : {}) }).client, ref));
    expect(l.attempts.map((a) => a.attempt)).toEqual([1]);
    expect(l.unread).toEqual([{ attempt: 2, why: "GitHub returned run 71 when attempt 2 of run 70 was requested." }]);
  });

  it("when the number of attempts cannot be known, the load fails instead of returning nothing", async () => {
    const failing = { getRun: async () => Promise.reject(new GitHubError({ kind: "not-found-or-no-permission" })), getJobs: async () => [] };
    await expect(loadAttempts(failing, ref)).rejects.toBeInstanceOf(GitHubError);
    await expect(loadAttempts(fakeClient(2).client, ref, run(2, { id: 99 }))).rejects.toThrow(new AttemptDiscoveryError("GitHub returned run 99 when run 70 was requested, so its attempts are not known."));
    for (const bad of [0, undefined, 1.5]) {
      const { client, calls } = fakeClient(2);
      await expect(loadAttempts(client, ref, run(2, { run_attempt: bad as number }))).rejects.toThrow("GitHub did not report how many attempts the run has.");
      expect(calls).toEqual([]);
    }
  });

  it("cancelled before loading: no request, and nothing returned", async () => {
    const { client, calls } = fakeClient(3);
    const ac = new AbortController();
    ac.abort();
    expect(await loadAttempts(client, ref, undefined, ac.signal)).toEqual({ cancelled: true });
    expect(calls).toEqual([]);
  });

  it("cancelled while loading: no further requests, and no partial result", async () => {
    const ac = new AbortController();
    const { client, calls } = fakeClient(6, { delay: () => 5, onCall: (c) => c.method === "getJobs" && c.attempt === 1 && ac.abort() });
    expect(await loadAttempts(client, ref, run(6), ac.signal)).toEqual({ cancelled: true });
    // The requests already in flight when it was cancelled (at most one per worker), and none after.
    const at = calls.findIndex((c) => c.method === "getJobs" && c.attempt === 1);
    expect(calls.length - at - 1).toBeLessThanOrEqual(1);
    expect(calls.some((c) => (c.attempt ?? 0) > 2)).toBe(false);
  });

  it("never has more than the configured number of requests in flight", async () => {
    const two = fakeClient(8, { delay: () => 3 });
    done(await loadAttempts(two.client, ref, run(8)));
    expect(two.max()).toBe(2);
    const one = fakeClient(5, { delay: () => 3 });
    done(await loadAttempts(one.client, ref, run(5), undefined, { attempts: 10, concurrency: 1 }));
    expect(one.max()).toBe(1);
  });

  it("reads only the latest attempts within the limit, and reports the earlier ones as not read", async () => {
    const { client, calls } = fakeClient(5);
    const l = done(await loadAttempts(client, ref, run(5), undefined, { attempts: 3, concurrency: 2 }));
    expect(l.attempts.map((a) => a.attempt)).toEqual([3, 4, 5]);
    expect(l.unread).toEqual([
      { attempt: 1, why: "not loaded: only the latest 3 attempts are read" },
      { attempt: 2, why: "not loaded: only the latest 3 attempts are read" },
    ]);
    expect(calls.some((c) => c.attempt === 1 || c.attempt === 2)).toBe(false);
  });

  it("the result does not depend on the order responses arrive in", async () => {
    // Earlier attempts answer last.
    const slowFirst = done(await loadAttempts(fakeClient(4, { delay: (c) => (5 - (c.attempt ?? 5)) * 4, failJobs: new Set([3]) }).client, ref));
    const fastFirst = done(await loadAttempts(fakeClient(4, { delay: (c) => (c.attempt ?? 0) * 4, failJobs: new Set([3]) }).client, ref));
    expect(slowFirst).toEqual(fastFirst);
    expect(slowFirst.attempts.map((a) => a.attempt)).toEqual([1, 2, 4]);
  });

  it("an attempt not read never becomes a success in the evidence", async () => {
    // Attempt 2 (the success) cannot be read: attempt 1's failure is not a recovery, and the run is not counted.
    const l = done(await loadAttempts(fakeClient(2, { failJobs: new Set([2]) }).client, ref));
    const e = retryEvidence(retryInput(l));
    expect(e.attemptsMissing).toEqual([{ attempt: 2, why: "GitHub request failed: network" }]);
    expect(e.jobs.flatMap((j) => j.findings.map((f) => f.kind))).not.toContain("recovered on retry");
    expect(e.jobs.flatMap((j) => j.observations.map((o) => o.outcome))).toEqual(["failed"]);
    expect(e.acrossRuns.target).toMatchObject({ included: false, why: "its latest attempt (2) was not read" });
  });

  it("feeds the evidence model with conclusions and attempt numbers as GitHub reported them", async () => {
    const l = done(await loadAttempts(fakeClient(2, { jobsOf: (n) => (n === 1 ? [job(10, "startup_failure", 1)] : [job(20, "success", 2)]) }).client, ref));
    const input = retryInput(l, { history: null, graphOf: () => null });
    expect(input).toMatchObject({ runId: 70, latestAttempt: 2, unread: [], history: null });
    expect(input.attempts.map((a) => [a.attempt, a.graph, a.jobs[0]!.conclusion])).toEqual([
      [1, null, "startup_failure"],
      [2, null, "success"],
    ]);
    const [f] = retryEvidence(input).jobs[0]!.findings;
    expect(f).toMatchObject({ kind: "recovered on retry", failed: { jobId: 10, conclusion: "startup_failure" }, succeeded: { jobId: 20 } });
  });

  it("through the GitHub client, every request is a GET to the run, attempt and attempt-jobs endpoints", async () => {
    const seen: TransportRequest[] = [];
    const transport: Transport = async (req) => {
      seen.push(req);
      const path = new URL(req.url).pathname;
      const attempt = Number(path.match(/attempts\/(\d+)/)?.[1] ?? 2);
      const body = path.endsWith("/jobs") ? { jobs: [job(attempt * 10, "success", attempt)] } : run(attempt);
      return { response: new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }), finalHost: "api.github.com" };
    };
    const client = createGitHubClient({ apiBase: "https://api.github.com", transport });
    done(await loadAttempts(client, ref));
    expect(new Set(seen.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(seen.map((r) => r.url).sort()).toEqual([
      "https://api.github.com/repos/o/r/actions/runs/70",
      "https://api.github.com/repos/o/r/actions/runs/70/attempts/1",
      "https://api.github.com/repos/o/r/actions/runs/70/attempts/1/jobs?per_page=100",
      "https://api.github.com/repos/o/r/actions/runs/70/attempts/2",
      "https://api.github.com/repos/o/r/actions/runs/70/attempts/2/jobs?per_page=100",
    ]);
    expect(seen.every((r) => !r.headers || !Object.keys(r.headers).some((k) => k.toLowerCase() === "authorization"))).toBe(true);
  });
});
