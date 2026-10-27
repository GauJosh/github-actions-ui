// Loading a repository's releases and resolving a bounded number of their tags (SYNTHETIC releases, refs and tags).
import { describe, expect, it } from "vitest";
import { releaseEvidence } from "../domain/insights/release-evidence";
import { GitHubError } from "../github/client";
import { hasMoreReleases, loadMoreReleases, loadReleases, RELEASE_LIMITS } from "./releases";

const repo = { owner: "acme-synthetic", repo: "app" };
const C = "c".repeat(40);
const OTHER = "d".repeat(40);
const T1 = "1".repeat(40);
const T2 = "2".repeat(40);
const RUN = "https://github.com/acme-synthetic/app/actions/runs/500";

const release = (id: number, tag: string, extra: Record<string, unknown> = {}) => ({
  id,
  tag_name: tag,
  name: `Synthetic ${tag}`,
  target_commitish: "main",
  draft: false,
  prerelease: false,
  created_at: "2026-10-25T09:00:00Z",
  published_at: "2026-10-25T10:00:00Z",
  html_url: `https://github.com/acme-synthetic/app/releases/tag/${tag}`,
  author: { login: "synthetic-user" },
  ...extra,
});
const ref = (tag: string, type: string, sha: string) => ({ ref: `refs/tags/${tag}`, object: { type, sha } });
const tagObject = (sha: string, tag: string, type: string, target: string) => ({ sha, tag, object: { type, sha: target } });
const notFound = () => new GitHubError({ kind: "not-found-or-no-permission" });

function fakeClient(releases: unknown, refs: Record<string, unknown>, objects: Record<string, unknown> = {}, opts: { delay?: number; more?: boolean } = {}) {
  const calls: string[] = [];
  let inflight = 0;
  let max = 0;
  const step = async <T,>(name: string, value: unknown): Promise<T> => {
    calls.push(name);
    inflight++;
    max = Math.max(max, inflight);
    await new Promise((r) => setTimeout(r, opts.delay ?? 1));
    inflight--;
    if (value instanceof Error) throw value;
    if (value === undefined) throw notFound();
    return value as T;
  };
  const client = {
    listReleases: async () => ({ releases, hasNext: Boolean(opts.more) }),
    getTagRef: (_: unknown, tag: string) => step<unknown>(`ref:${tag}`, refs[tag]),
    getTagObject: (_: unknown, sha: string) => step<unknown>(`tag:${sha.slice(0, 3)}`, objects[sha]),
  };
  return { client, calls, max: () => max };
}

const evidenceOf = (loaded: Awaited<ReturnType<typeof loadReleases>>) => releaseEvidence({ repo, run: { id: 500, head_sha: C, conclusion: "success", html_url: RUN }, deployments: [], releases: loaded.releases });

describe("loading releases", () => {
  it("lightweight and annotated tags resolved; a different commit, a missing tag and failed lookups kept apart; release fields preserved", async () => {
    const { client, calls } = fakeClient(
      [release(1, "v3.0.0"), release(2, "v2.0.0"), release(3, "v1.0.0"), release(4, "v0.9.0"), release(5, "v0.8.0"), release(6, "v0.7.0"), release(7, "v0.6.0", { draft: true, published_at: null })],
      {
        "v3.0.0": ref("v3.0.0", "commit", C),
        "v2.0.0": ref("v2.0.0", "tag", T1),
        "v1.0.0": ref("v1.0.0", "commit", OTHER),
        // v0.9.0: 404, no such tag
        "v0.8.0": new GitHubError({ kind: "rate-limited" }),
        "v0.7.0": new GitHubError({ kind: "http-error", status: 502 }),
        // v0.6.0 (draft): 404
      },
      { [T1]: tagObject(T1, "v2.0.0", "commit", C) },
    );
    const loaded = await loadReleases(client, repo, { head_sha: C });
    expect(loaded.releases.map((r) => [(r.release as { tag_name: string }).tag_name, r.tag.state])).toEqual([
      ["v3.0.0", "loaded"],
      ["v2.0.0", "loaded"],
      ["v1.0.0", "loaded"],
      ["v0.9.0", "not found"],
      ["v0.8.0", "failed"],
      ["v0.7.0", "failed"],
      ["v0.6.0", "not found"],
    ]);
    expect(loaded.failed).toEqual([
      { tag: "v0.8.0", why: "rate-limited" },
      { tag: "v0.7.0", why: "http-error" },
    ]);
    expect(calls.filter((c) => c.startsWith("tag:"))).toEqual(["tag:111"]);
    expect(loaded).toMatchObject({ moreReleases: false, unresolved: 0, requests: 8, cancelled: false });
    // Only documented fields are passed on.
    expect(loaded.releases[0]!.release).not.toHaveProperty("author");

    const e = evidenceOf(loaded);
    expect(e.releases.map((r) => [r.tag, r.commit.match, r.commit.via ?? null, r.draft])).toEqual([
      ["v3.0.0", "confirmed commit", "lightweight tag", false],
      ["v2.0.0", "confirmed commit", "annotated tag", false],
      ["v1.0.0", "different commit", "lightweight tag", false],
      ["v0.9.0", "unknown", null, false],
      ["v0.8.0", "unknown", null, false],
      ["v0.7.0", "unknown", null, false],
      ["v0.6.0", "unknown", null, true],
    ]);
    expect(e.releases[3]!.commit.basis).toEqual(["GitHub has no tag v0.9.0."]);
    expect(e.releases[4]!.commit.basis).toEqual(["Its tag could not be looked up (rate-limited)."]);
    expect(e.releases[0]).toMatchObject({ id: 1, name: "Synthetic v3.0.0", url: "https://github.com/acme-synthetic/app/releases/tag/v3.0.0", publishedAt: "2026-10-25T10:00:00Z", createdAt: "2026-10-25T09:00:00Z" });
    expect(e.releases[6]).not.toHaveProperty("publishedAt");
  });

  it("an empty listing makes no tag request", async () => {
    const { client, calls } = fakeClient([], {});
    const loaded = await loadReleases(client, repo, { head_sha: C });
    expect(loaded.releases).toEqual([]);
    expect(calls).toEqual([]);
    expect(evidenceOf(loaded).notes).toContain("No release's tag is confirmed to point to this commit; not every deployment has a release.");
  });

  it("nested annotated tags are followed; a loop or a failed tag object stops without guessing", async () => {
    const { client, calls } = fakeClient(
      [release(1, "nested"), release(2, "loop"), release(3, "broken")],
      { nested: ref("nested", "tag", T1), loop: ref("loop", "tag", "a".repeat(40)), broken: ref("broken", "tag", "b".repeat(40)) },
      {
        [T1]: tagObject(T1, "nested", "tag", T2),
        [T2]: tagObject(T2, "inner", "commit", C),
        ["a".repeat(40)]: tagObject("a".repeat(40), "loop", "tag", "e".repeat(40)),
        ["e".repeat(40)]: tagObject("e".repeat(40), "x", "tag", "a".repeat(40)),
        ["b".repeat(40)]: new GitHubError({ kind: "http-error", status: 500 }),
      },
    );
    const loaded = await loadReleases(client, repo, { head_sha: C });
    // Each tag object is read once; the loop stops when it comes back to one already read.
    expect(calls.filter((c) => c.startsWith("tag:")).sort()).toEqual(["tag:111", "tag:222", "tag:aaa", "tag:bbb", "tag:eee"]);
    expect(loaded.releases[2]!.tag).toEqual({ state: "failed", why: "annotated tag object: http-error" });
    const e = evidenceOf(loaded);
    expect(e.releases.map((r) => [r.tag, r.commit.match])).toEqual([
      ["nested", "confirmed commit"],
      ["loop", "unknown"],
      ["broken", "unknown"],
    ]);
    expect(e.releases[1]!.commit.basis).toEqual(["Its annotated tags point at each other in a loop."]);
  });

  it("partial failure keeps the usable releases, and a 404 for an annotated tag object is a failure, not a missing tag", async () => {
    const { client } = fakeClient([release(1, "v1"), release(2, "v2")], { v1: ref("v1", "commit", C), v2: ref("v2", "tag", T1) });
    const loaded = await loadReleases(client, repo, { head_sha: C });
    expect(loaded.releases.map((r) => r.tag.state)).toEqual(["loaded", "failed"]);
    expect(loaded.failed).toEqual([{ tag: "v2", why: "annotated tag object: not-found-or-no-permission" }]);
    expect(evidenceOf(loaded).releases.map((r) => r.commit.match)).toEqual(["confirmed commit", "unknown"]);
  });

  it("malformed responses: a listing that is not a list fails; bad items are counted, never looked up; a bad ref or unreadable body is not resolved", async () => {
    await expect(loadReleases(fakeClient({ message: "synthetic" }, {}).client, repo, { head_sha: C })).rejects.toThrow("GitHub's releases response was not a list.");
    const { client, calls } = fakeClient([release(1, "v1"), { id: "x", tag_name: "v2" }, "junk", release(3, "v3")], { v1: [ref("v1", "commit", C)], v3: new SyntaxError("Unexpected token") });
    const loaded = await loadReleases(client, repo, { head_sha: C });
    expect(calls).toEqual(["ref:v1", "ref:v3"]);
    expect(loaded.failed).toEqual([{ tag: "v3", why: "unreadable response" }]);
    const e = evidenceOf(loaded);
    expect(e.malformedReleases).toBe(2);
    expect(e.releases.map((r) => [r.tag, r.commit.match, r.commit.basis[0]])).toEqual([
      ["v1", "unknown", "GitHub's tag reference response lacked expected fields."],
      ["v3", "unknown", "Its tag could not be looked up (unreadable response)."],
    ]);
  });

  it("at most two lookups in flight, at most 10 releases resolved and 20 tag requests; the run's commit and published releases first", async () => {
    const list = Array.from({ length: 30 }, (_, i) => release(i + 1, `v${i + 1}`, i === 25 ? { target_commitish: C } : i === 0 ? { draft: true } : {}));
    const refs = Object.fromEntries(list.map((r) => [r.tag_name, ref(r.tag_name, "tag", String((r.id % 9) + 1).repeat(40))]));
    // Every tag is annotated and its object points at another tag object, so each lookup wants several requests.
    const objects = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1).repeat(40), tagObject(String(i + 1).repeat(40), "x", "commit", OTHER)]));
    const { client, calls, max } = fakeClient(list, refs, objects, { delay: 3, more: true });
    const loaded = await loadReleases(client, repo, { head_sha: C });
    expect(max()).toBe(2);
    const refCalls = calls.filter((c) => c.startsWith("ref:"));
    expect(refCalls.length).toBe(RELEASE_LIMITS.tags);
    // v26 names the run's commit, so it comes first; the draft v1 is not reached.
    expect(refCalls[0]).toBe("ref:v26");
    expect(refCalls).not.toContain("ref:v1");
    expect(calls.length).toBe(loaded.requests);
    expect(loaded.requests).toBeLessThanOrEqual(RELEASE_LIMITS.requests);
    expect(loaded).toMatchObject({ moreReleases: true, unresolved: 20 });
    // With a tighter budget the chain is cut short and left unresolved, never guessed.
    const small = [release(1, "a"), release(2, "b"), release(3, "c")];
    const tight = await loadReleases(
      fakeClient(small, { a: ref("a", "commit", OTHER), b: ref("b", "tag", T1), c: ref("c", "tag", T2) }, { [T1]: tagObject(T1, "b", "commit", OTHER), [T2]: tagObject(T2, "c", "commit", C) }).client,
      repo,
      { head_sha: C },
      undefined,
      { tags: 3, requests: 4, concurrency: 2 },
    );
    expect(tight.requests).toBe(4);
    const cut = evidenceOf(tight).releases;
    expect(cut.map((r) => r.commit.match)).toEqual(["different commit", "different commit", "unknown"]);
    expect(cut[2]!.commit.basis).toEqual(["Annotated tag object 2222222 was not loaded."]);
  });

  it("cancellation: no further requests once aborted, and the result is marked cancelled", async () => {
    const list = Array.from({ length: 8 }, (_, i) => release(i + 1, `v${i + 1}`));
    const { client, calls } = fakeClient(list, Object.fromEntries(list.map((r) => [r.tag_name, ref(r.tag_name, "commit", C)])), {}, { delay: 5 });
    const ac = new AbortController();
    const pending = loadReleases(client, repo, { head_sha: C }, ac.signal);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const loaded = await pending;
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(loaded.cancelled).toBe(true);
  });
});

describe("checking more releases", () => {
  // Pages of releases, as GitHub's listing returns them; a page can be an Error to fail the listing.
  function pagedClient(pages: (unknown[] | Error)[], refs: Record<string, unknown>, opts: { delay?: number } = {}) {
    const listed: number[] = [];
    const calls: string[] = [];
    let inflight = 0;
    let max = 0;
    const client = {
      listReleases: async (_: unknown, page = 1) => {
        listed.push(page);
        const p = pages[page - 1];
        if (p instanceof Error) throw p;
        return { releases: p ?? [], hasNext: page < pages.length };
      },
      getTagRef: async (_: unknown, tag: string) => {
        calls.push(tag);
        inflight++;
        max = Math.max(max, inflight);
        await new Promise((r) => setTimeout(r, opts.delay ?? 1));
        inflight--;
        if (refs[tag] === undefined) throw notFound();
        return refs[tag];
      },
      getTagObject: async () => {
        throw new Error("not used");
      },
    };
    return { client, listed, calls, max: () => max };
  }
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => release(from + i, `v${from + i}`));
  const refsFor = (list: { tag_name: string }[], sha = OTHER) => Object.fromEntries(list.map((r) => [r.tag_name, ref(r.tag_name, "commit", sha)]));
  const states = (l: Awaited<ReturnType<typeof loadReleases>>) => l.releases.map((r) => r.tag.state);
  const run = { head_sha: C };

  it("resolves the next batch with the same caps, keeps earlier results, and never changes the previous result", async () => {
    const first = page(1, 25);
    const { client, calls, max } = pagedClient([first], { ...refsFor(first), v24: ref("v24", "commit", C) }, { delay: 3 });
    const one = await loadReleases(client, repo, run);
    const before = JSON.stringify(one);
    expect(one).toMatchObject({ unresolved: 15, requests: 10, totalRequests: 10 });
    expect(hasMoreReleases(one)).toBe(true);

    const two = await loadMoreReleases(client, repo, run, one);
    expect(JSON.stringify(one)).toBe(before);
    expect(two).toMatchObject({ unresolved: 5, requests: 10, totalRequests: 20, pages: 1 });
    // Earlier lookups are kept as they were, not repeated.
    expect(two.releases.slice(0, 10)).toEqual(one.releases.slice(0, 10));
    expect(calls).toEqual([...new Set(calls)]);
    expect(max()).toBe(2);

    const three = await loadMoreReleases(client, repo, run, two);
    expect(three).toMatchObject({ unresolved: 0, requests: 5, totalRequests: 25 });
    expect(hasMoreReleases(three)).toBe(false);
    expect(calls).toHaveLength(25);
    // v24 was in the second batch and resolves to the run's commit.
    const e = evidenceOf(three);
    expect(e.releases.filter((r) => r.commit.match === "confirmed commit").map((r) => r.tag)).toEqual(["v24"]);
  });

  it("not looked up yet stays apart from looked up and unresolved", async () => {
    const list = page(1, 12);
    const refs = refsFor(list);
    delete refs["v2"]; // 404: looked up, no such tag
    const { client } = pagedClient([list], refs);
    const one = await loadReleases(client, repo, run);
    expect(states(one)).toEqual(["loaded", "not found", "loaded", "loaded", "loaded", "loaded", "loaded", "loaded", "loaded", "loaded", "not loaded", "not loaded"]);
    const two = await loadMoreReleases(client, repo, run, one);
    expect(states(two).slice(10)).toEqual(["loaded", "loaded"]);
    expect(two.releases[1]!.tag).toEqual({ state: "not found" });
  });

  it("deduplicates by tag and by release id: a shared tag is looked up once, a release repeated on the next page is not added again", async () => {
    const shared = [release(1, "v1"), release(2, "v1"), release(3, "v3")];
    const { client, calls } = pagedClient([shared, [release(3, "v3"), release(4, "v4")]], refsFor([...shared, release(4, "v4")]));
    const one = await loadReleases(client, repo, run);
    expect(calls).toEqual(["v1", "v3"]);
    expect(one.releases[0]!.tag).toEqual(one.releases[1]!.tag);
    // Every loaded release looked up, and GitHub lists another page: the next action reads it.
    const two = await loadMoreReleases(client, repo, run, one);
    expect(two.pages).toBe(2);
    expect(two.releases.map((r) => (r.release as { id: number }).id)).toEqual([1, 2, 3, 4]);
    expect(calls).toEqual(["v1", "v3", "v4"]);
    expect(two).toMatchObject({ moreReleases: false, unresolved: 0, requests: 1 });
  });

  it("pagination: the next page is read only once the loaded releases are all looked up, and a tag seen on an earlier page is reused", async () => {
    const p1 = page(1, 30);
    const p2 = [release(31, "v31"), release(32, "v5")];
    const { client, listed, calls } = pagedClient([p1, p2], { ...refsFor(p1), v31: ref("v31", "commit", C) });
    let l = await loadReleases(client, repo, run);
    l = await loadMoreReleases(client, repo, run, l);
    l = await loadMoreReleases(client, repo, run, l);
    expect(listed).toEqual([1]);
    expect(l).toMatchObject({ unresolved: 0, moreReleases: true });
    l = await loadMoreReleases(client, repo, run, l);
    expect(listed).toEqual([1, 2]);
    expect(calls.filter((c) => c === "v5")).toHaveLength(1);
    expect(l.releases[31]!.tag).toEqual(l.releases[4]!.tag);
    expect(evidenceOf(l).releases.find((r) => r.tag === "v31")!.commit.match).toBe("confirmed commit");
    expect(hasMoreReleases(l)).toBe(false);
  });

  it("a failed next page leaves the previous result usable, and retrying the same action succeeds", async () => {
    const p1 = page(1, 3);
    const pages: (unknown[] | Error)[] = [p1, new GitHubError({ kind: "rate-limited" })];
    const { client, listed } = pagedClient(pages, refsFor([...p1, release(4, "v4")]));
    const one = await loadReleases(client, repo, run);
    const before = JSON.stringify(one);
    await expect(loadMoreReleases(client, repo, run, one)).rejects.toThrow("GitHub request failed: rate-limited");
    expect(JSON.stringify(one)).toBe(before);
    pages[1] = [release(4, "v4")];
    const retried = await loadMoreReleases(client, repo, run, one);
    expect(listed).toEqual([1, 2, 2]);
    expect(retried.releases.map((r) => r.tag.state)).toEqual(["loaded", "loaded", "loaded", "loaded"]);
  });

  it("cancellation during a later batch: no further requests, marked cancelled, previous result untouched", async () => {
    const list = page(1, 20);
    const { client, calls } = pagedClient([list], refsFor(list), { delay: 5 });
    const one = await loadReleases(client, repo, run);
    const before = JSON.stringify(one);
    const ac = new AbortController();
    // Abort as soon as the second batch's first tag request starts (not on a timer, which depends on load).
    const getTagRef = client.getTagRef;
    client.getTagRef = (r, tag) => {
      if (calls.length === 10) ac.abort();
      return getTagRef(r, tag);
    };
    const two = await loadMoreReleases(client, repo, run, one, ac.signal);
    expect(two.cancelled).toBe(true);
    // The request that triggered the abort finishes; the other worker checks the signal first and starts nothing.
    expect(calls).toHaveLength(11);
    expect(JSON.stringify(one)).toBe(before);
  });
});
