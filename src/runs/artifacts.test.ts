// The artifact loader against a fake client (SYNTHETIC artifacts).
import { describe, expect, it } from "vitest";
import { artifactEvidence } from "../domain/insights/artifacts";
import { GitHubError } from "../github/client";
import { ARTIFACT_LIMITS, loadArtifacts, MalformedArtifactListing } from "./artifacts";

const ref = { owner: "acme-synthetic", repo: "app", runId: 500 };
const C = "c".repeat(40);
const artifact = (id: number) => ({ id, name: `synthetic-${id}`, size_in_bytes: id, expired: false, workflow_run: { id: 500, head_sha: C } });
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => artifact(from + i));

/** Pages as GitHub would return them; a page can be an Error to fail it, or any body to return as is. */
function fakeClient(pages: (unknown | Error)[], onCall?: (page: number) => void) {
  const calls: number[] = [];
  const client = {
    listRunArtifacts: async (r: typeof ref, page = 1) => {
      expect(r).toBe(ref);
      calls.push(page);
      onCall?.(page);
      await new Promise((done) => setTimeout(done, 1));
      const p = pages[page - 1];
      if (p instanceof Error) throw p;
      return { body: p, hasNext: page < pages.length };
    },
  };
  return { client, calls };
}
const body = (artifacts: unknown[], total_count: number) => ({ total_count, artifacts });

describe("loading run artifacts", () => {
  it("reads pages one after another, keeps total_count, and stops when GitHub lists no further page", async () => {
    const { client, calls } = fakeClient([body(range(1, 100), 130), body(range(101, 30), 130)]);
    const l = await loadArtifacts(client, ref);
    expect(calls).toEqual([1, 2]);
    expect(l).toMatchObject({ pages: 2, totalCount: 130, morePages: false, cancelled: false });
    expect(l.items).toHaveLength(130);
    expect(artifactEvidence({ run: { id: 500, head_sha: C, status: "completed", run_attempt: 1 }, listing: l }).listing).toBe("complete");
  });

  it("an empty listing is one request and a real answer", async () => {
    const { client, calls } = fakeClient([body([], 0)]);
    const l = await loadArtifacts(client, ref);
    expect(calls).toEqual([1]);
    expect(l).toMatchObject({ items: [], totalCount: 0, morePages: false, pages: 1 });
  });

  it("stops at the page cap; the rest is reported as incomplete, not as absent", async () => {
    expect(ARTIFACT_LIMITS.pages).toBe(3);
    const { client, calls } = fakeClient([body(range(1, 100), 450), body(range(101, 100), 450), body(range(201, 100), 450), body(range(301, 100), 450), body(range(401, 50), 450)]);
    const l = await loadArtifacts(client, ref);
    expect(calls).toEqual([1, 2, 3]);
    expect(l).toMatchObject({ pages: 3, morePages: true, totalCount: 450 });
    const e = artifactEvidence({ run: { id: 500, head_sha: C, status: "completed", run_attempt: 1 }, listing: l });
    expect(e).toMatchObject({ listing: "incomplete", read: 300 });
    expect(e.notes).toContain("300 of 450 artifacts GitHub lists for this run were read.");
  });

  it("keeps each artifact id once when the listing shifts between pages", async () => {
    // A new artifact uploaded between the two requests pushes artifact 100 onto page two.
    const { client } = fakeClient([body(range(1, 100), 101), body([artifact(100), artifact(101)], 102)]);
    const l = await loadArtifacts(client, ref);
    expect(l.items.map((a) => (a as { id: number }).id)).toEqual(range(1, 101).map((a) => a.id));
    expect(l.totalCount).toBe(102);
    // The newest artifact was not read: GitHub's count says so.
    expect(artifactEvidence({ run: { id: 500, head_sha: C, status: "completed", run_attempt: 1 }, listing: l }).listing).toBe("incomplete");
  });

  it("passes malformed items on so they are counted, and never deduplicates items without a numeric id", async () => {
    const { client } = fakeClient([body([artifact(1), { name: "no id" }, { name: "no id" }, artifact(1)], 4)]);
    const l = await loadArtifacts(client, ref);
    expect(l.items).toHaveLength(3);
    expect(artifactEvidence({ run: { id: 500, head_sha: C, status: "completed", run_attempt: 1 }, listing: l })).toMatchObject({ read: 1, malformed: 2 });
  });

  it.each([
    ["a list instead of an object", []],
    ["no artifacts list", { total_count: 1 }],
    ["no total_count", { artifacts: [] }],
    ["a negative total_count", { total_count: -1, artifacts: [] }],
    ["null", null],
  ])("a malformed listing (%s) fails the action", async (_, page) => {
    const { client } = fakeClient([page]);
    await expect(loadArtifacts(client, ref)).rejects.toBeInstanceOf(MalformedArtifactListing);
  });

  it("a failing second page fails the action; the first page is not presented as the listing", async () => {
    const { client, calls } = fakeClient([body(range(1, 100), 150), new GitHubError({ kind: "http-error", status: 502 })]);
    const error = await loadArtifacts(client, ref).catch((e: unknown) => e);
    expect((error as GitHubError).failure).toEqual({ kind: "http-error", status: 502 });
    expect(calls).toEqual([1, 2]);
    const malformed = fakeClient([body(range(1, 100), 150), { message: "unexpected" }]);
    await expect(loadArtifacts(malformed.client, ref)).rejects.toThrow("page 2");
  });

  it.each([
    [{ kind: "not-found-or-no-permission" } as const],
    [{ kind: "auth-failed" } as const],
    [{ kind: "permission", detail: "Resource not accessible by personal access token" } as const],
    [{ kind: "rate-limited", resetAt: 1_700_000_000_000 } as const],
    [{ kind: "network" } as const],
  ])("keeps the client's classification: %o", async (failure) => {
    const { client } = fakeClient([new GitHubError(failure)]);
    const error = await loadArtifacts(client, ref).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).failure).toEqual(failure);
  });

  it("cancellation between pages: no further request, marked cancelled", async () => {
    const ac = new AbortController();
    const { client, calls } = fakeClient([body(range(1, 100), 250), body(range(101, 100), 250), body(range(201, 50), 250)], (page) => {
      if (page === 2) ac.abort();
    });
    const l = await loadArtifacts(client, ref, ac.signal);
    expect(calls).toEqual([1, 2]);
    expect(l.cancelled).toBe(true);
  });

  it("an action aborted before it starts makes no request; one aborted during its last page is still cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const before = fakeClient([body([], 0)]);
    expect((await loadArtifacts(before.client, ref, ac.signal)).cancelled).toBe(true);
    expect(before.calls).toEqual([]);
    const late = new AbortController();
    const last = fakeClient([body([artifact(1)], 1)], () => late.abort());
    expect((await loadArtifacts(last.client, ref, late.signal)).cancelled).toBe(true);
  });
});
