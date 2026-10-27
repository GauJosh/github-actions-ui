// Loading a commit's GitHub deployments (SYNTHETIC deployments and statuses): validation, failure vs. empty,
// concurrency and cancellation.
import { describe, expect, it } from "vitest";
import { releaseEvidence } from "../domain/insights/release-evidence";
import { loadDeployments } from "./deployments";

const repo = { owner: "acme-synthetic", repo: "app" };
const C = "c".repeat(40);
const RUN = "https://github.com/acme-synthetic/app/actions/runs/500";
const dep = (id: number, environment = "env-a") => ({ id, sha: C, ref: "main", environment, created_at: "2026-10-25T10:00:00Z", creator: { login: "synthetic-user" } });

function fakeClient(deployments: unknown[], statuses: Map<number, unknown[] | Error>, opts: { delay?: number; more?: boolean } = {}) {
  const calls: number[] = [];
  const shas: string[] = [];
  let inflight = 0;
  let max = 0;
  const client = {
    listDeployments: async (_: unknown, sha: string) => {
      shas.push(sha);
      return { deployments, hasNext: Boolean(opts.more) };
    },
    getDeploymentStatuses: async (_: unknown, id: number) => {
      calls.push(id);
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, opts.delay ?? 1));
      inflight--;
      const s = statuses.get(id) ?? [];
      if (s instanceof Error) throw s;
      return { statuses: s, hasNext: id === 3 };
    },
  };
  return { client, calls, shas, max: () => max };
}

describe("loading deployments of a run's commit", () => {
  it("lists by the run's commit, reads each deployment's statuses, and keeps a failed status request apart from an empty one", async () => {
    const { client, shas } = fakeClient(
      [dep(1), dep(2, "env-b"), dep(3, "env-b"), { sha: C }, "junk"],
      new Map<number, unknown[] | Error>([
        [1, [{ id: 11, state: "success", log_url: `${RUN}/job/9`, created_at: "2026-10-25T10:02:00Z" }, { id: 10, state: "queued", created_at: "2026-10-25T10:01:00Z" }, { state: "success" }]],
        [2, new Error("GitHub request failed: http-error")],
        [3, []],
      ]),
      { more: true },
    );
    const loaded = await loadDeployments(client, repo, { head_sha: C });
    expect(shas).toEqual([C]);
    expect(loaded.deployments.map((d) => [d.deployment.id, d.deployment.environment, d.statuses?.map((s) => s.id) ?? null])).toEqual([
      [1, "env-a", [11, 10]],
      [2, "env-b", null],
      [3, "env-b", []],
    ]);
    expect(loaded).toMatchObject({ moreDeployments: true, failed: [{ id: 2, why: "GitHub request failed: http-error" }], moreStatuses: [3], malformed: 3 });
    // Only the documented fields are kept.
    expect(loaded.deployments[0]!.deployment).not.toHaveProperty("creator");

    const e = releaseEvidence({ repo, run: { id: 500, head_sha: C, conclusion: "success", html_url: RUN }, deployments: loaded.deployments });
    expect(e.deployments.map((d) => [d.id, d.association, d.outcome])).toEqual([
      [1, "confirmed", "succeeded"],
      [2, "same commit", "statuses not loaded"],
      [3, "same commit", "no status"],
    ]);
    expect(e.deployments[1]!.basis).toEqual(["Same commit; its statuses could not be read, so whether they link to this run is unknown."]);
  });

  it("never has more than two status requests in flight", async () => {
    const { client, calls, max } = fakeClient(Array.from({ length: 7 }, (_, i) => dep(i + 1)), new Map(), { delay: 5 });
    await loadDeployments(client, repo, { head_sha: C });
    expect(max()).toBe(2);
    expect(calls.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("starts no further status requests once cancelled", async () => {
    const { client, calls } = fakeClient(Array.from({ length: 7 }, (_, i) => dep(i + 1)), new Map(), { delay: 5 });
    const ac = new AbortController();
    const pending = loadDeployments(client, repo, { head_sha: C }, ac.signal);
    ac.abort();
    await pending;
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("an empty listing is a real answer: no deployment of this commit", async () => {
    const { client, calls } = fakeClient([], new Map());
    const loaded = await loadDeployments(client, repo, { head_sha: C });
    expect(loaded.deployments).toEqual([]);
    expect(calls).toEqual([]);
  });
});
