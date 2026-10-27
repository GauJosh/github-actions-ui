// Releases and their tags (SYNTHETIC repositories, tags, commits and releases).
import { describe, expect, it } from "vitest";
import { releaseEvidence, releaseNotes, type EvidenceInput } from "./release-evidence";
import { MAX_TAG_DEPTH, releaseOf, resolveTag, toRelease, type GitHubRelease, type TagLookup } from "./release-tags";

const C = "c".repeat(40);
const OTHER = "d".repeat(40);
const T1 = "1".repeat(40);
const T2 = "2".repeat(40);
const repo = { owner: "acme-synthetic", repo: "app" };
const RUN = "https://github.com/acme-synthetic/app/actions/runs/500";

// GitHub's documented shapes: GET …/git/ref/tags/{tag} and GET …/git/tags/{sha}.
const ref = (tag: string, type: string, sha: string) => ({ ref: `refs/tags/${tag}`, node_id: "synthetic", url: "https://api.github.com/synthetic", object: { type, sha, url: "https://api.github.com/synthetic" } });
const tagObject = (sha: string, tag: string, type: string, target: string) => ({ sha, tag, message: "synthetic", tagger: { name: "synthetic-user" }, object: { type, sha: target } });
const loaded = (r: unknown, tagObjects?: unknown[]): TagLookup => ({ state: "loaded", ref: r, ...(tagObjects && { tagObjects }) });
const rel = (id: number, tag: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({ id, tag_name: tag, target_commitish: "main", ...extra });

describe("resolving a release's tag", () => {
  it("a lightweight tag points straight at a commit", () => {
    expect(resolveTag("v1", loaded(ref("v1", "commit", C)))).toEqual({ kind: "commit", sha: C, via: "lightweight tag", depth: 0 });
  });

  it("annotated tags are dereferenced, including a tag of a tag, in any order", () => {
    const lookup = loaded(ref("v2", "tag", T1), [tagObject(T2, "v2-inner", "commit", C), tagObject(T1, "v2", "tag", T2)]);
    expect(resolveTag("v2", lookup)).toEqual({ kind: "commit", sha: C, via: "annotated tag", depth: 2 });
  });

  it("an annotated chain that is incomplete, loops, is too long or ends at a tree is not resolved", () => {
    expect(resolveTag("v2", loaded(ref("v2", "tag", T1)))).toEqual({ kind: "unresolved", reason: "Annotated tag object 1111111 was not loaded." });
    expect(resolveTag("v2", loaded(ref("v2", "tag", T1), [tagObject(T1, "v2", "tag", T2), tagObject(T2, "x", "tag", T1)]))).toMatchObject({ reason: "Its annotated tags point at each other in a loop." });
    const chain = Array.from({ length: MAX_TAG_DEPTH + 1 }, (_, i) => tagObject(String(i + 3).repeat(40), i ? "inner" : "v2", "tag", String(i + 4).repeat(40)));
    expect(resolveTag("v2", loaded(ref("v2", "tag", "3".repeat(40)), chain))).toMatchObject({ reason: `More than ${MAX_TAG_DEPTH} annotated tags in a chain; not followed further.` });
    expect(resolveTag("v2", loaded(ref("v2", "tag", T1), [tagObject(T1, "v2", "tree", T2)]))).toMatchObject({ reason: "Its tag points at a tree, not a commit." });
  });

  it("malformed responses are not resolved; a ref or tag object for another name is a conflict", () => {
    expect(resolveTag("v1", loaded([ref("v1", "commit", C)]))).toMatchObject({ reason: "GitHub's tag reference response lacked expected fields." });
    expect(resolveTag("v1", loaded({ ref: "refs/tags/v1" }))).toMatchObject({ reason: "GitHub's tag reference response lacked expected fields." });
    expect(resolveTag("v1", loaded(ref("v1", "commit", "abc123")))).toMatchObject({ reason: "Its tag reference names no full SHA." });
    expect(resolveTag("v1", loaded(ref("v1", "tag", T1), [{ sha: T1, tag: "v1" }]))).toMatchObject({ reason: "GitHub's tag object response lacked expected fields." });
    expect(resolveTag("v1", loaded(ref("v1.0", "commit", C)))).toEqual({ kind: "unresolved", reason: "GitHub returned refs/tags/v1.0 for tag v1.", conflicting: true });
    expect(resolveTag("v1", loaded(ref("v1", "tag", T1), [tagObject(T1, "v0", "commit", C)]))).toMatchObject({ conflicting: true, reason: "Tag ref v1 points at an annotated tag named v0." });
  });

  it("releases without a numeric id or a tag name are not used", () => {
    expect(toRelease({ id: "1", tag_name: "v1" })).toBeNull();
    expect(toRelease({ id: 1, tag_name: "" })).toBeNull();
    expect(toRelease(null)).toBeNull();
    expect(toRelease({ id: 1, tag_name: "v1", draft: "yes", html_url: 5 })).toEqual({
      id: 1, tag_name: "v1", name: null, target_commitish: null, draft: false, prerelease: false, created_at: null, published_at: null, html_url: null,
    });
  });
});

describe("a release against the run's commit", () => {
  it("confirmed commit: the resolved tag is the run's commit; identity, draft and prerelease are kept; the run is not named by the release", () => {
    const e = releaseOf(C, rel(1, "v1.0.0", { name: "Synthetic 1.0", html_url: "https://github.com/acme-synthetic/app/releases/tag/v1.0.0", prerelease: true, created_at: "2026-10-25T09:00:00Z", published_at: "2026-10-25T10:00:00Z" }), loaded(ref("v1.0.0", "commit", C)));
    expect(e).toMatchObject({
      id: 1,
      tag: "v1.0.0",
      name: "Synthetic 1.0",
      url: "https://github.com/acme-synthetic/app/releases/tag/v1.0.0",
      draft: false,
      prerelease: true,
      createdAt: "2026-10-25T09:00:00Z",
      publishedAt: "2026-10-25T10:00:00Z",
      commit: { match: "confirmed commit", resolvedSha: C, via: "lightweight tag", basis: ["Its lightweight tag points to the run's commit."] },
      run: { relation: "shares the run's commit" },
    });
    expect(e.run.basis).toContain("did not necessarily create or publish it");
  });

  it("different commit: the tag decides, even when target_commitish names the run's commit", () => {
    const e = releaseOf(C, rel(2, "v0.9.0", { target_commitish: C }), loaded(ref("v0.9.0", "tag", T1), [tagObject(T1, "v0.9.0", "commit", OTHER)]));
    expect(e.commit).toEqual({
      match: "different commit",
      resolvedSha: OTHER,
      via: "annotated tag",
      basis: ["Its annotated tag points to ddddddd, not the run's ccccccc.", "Its target_commitish names ccccccc, which GitHub uses only when it creates the tag; the tag decides."],
    });
    expect(e.run.relation).toBe("not established");
  });

  it("a missing tag or failed lookup is unknown; target_commitish on the run's commit makes it possible, never confirmed", () => {
    expect(releaseOf(C, rel(3, "v3"), { state: "not found" }).commit).toEqual({ match: "unknown", basis: ["GitHub has no tag v3."] });
    expect(releaseOf(C, rel(3, "v3", { target_commitish: C }), { state: "not found" }).commit.match).toBe("unknown");
    expect(releaseOf(C, rel(4, "v4"), { state: "failed", why: "HTTP 503" }).commit).toEqual({ match: "unknown", basis: ["Its tag could not be looked up (HTTP 503)."] });
    expect(releaseOf(C, rel(5, "v5", { target_commitish: C }), { state: "failed", why: "HTTP 503" }).commit).toEqual({
      match: "possible",
      basis: ["Its tag could not be looked up (HTTP 503).", "Its target_commitish names the run's commit, but that is not proof: GitHub ignores it when the tag already exists."],
    });
    expect(releaseOf(C, rel(6, "v6", { target_commitish: C }), { state: "not loaded" }).commit.match).toBe("possible");
  });

  it("a draft whose tag does not exist yet: possible only through target_commitish, and said so", () => {
    const e = releaseOf(C, rel(7, "v7", { draft: true, target_commitish: C }), { state: "not found" });
    expect(e.draft).toBe(true);
    expect(e.commit.match).toBe("possible");
    expect(e.commit.basis).toContain("A draft release's tag may not exist until the release is published.");
    expect(releaseOf(C, rel(8, "v8", { draft: true }), { state: "not found" }).commit.match).toBe("unknown");
  });

  it("missing run commit: unknown, with the tag's commit kept", () => {
    const e = releaseOf(null, rel(9, "v9"), loaded(ref("v9", "commit", C)));
    expect(e.commit).toEqual({ match: "unknown", resolvedSha: C, via: "lightweight tag", basis: ["Its tag points to ccccccc, but the run's commit is unknown."] });
  });

  it("conflicting: GitHub's responses disagree about the tag", () => {
    const e = releaseOf(C, rel(10, "v10", { target_commitish: C }), loaded(ref("v10", "tag", T1), [tagObject(T1, "v1", "commit", C)]));
    expect(e.commit).toEqual({ match: "conflicting", basis: ["Tag ref v10 points at an annotated tag named v1."] });
    expect(e.run.relation).toBe("not established");
  });
});

describe("releases in the run's evidence", () => {
  const dep = (id: number, environment: string, sha = C) => ({ deployment: { id, sha, ref: "main", environment, created_at: "2026-10-25T10:00:00Z" }, statuses: [{ id: id * 10, state: "success", log_url: `${RUN}/job/9`, created_at: "2026-10-25T10:01:00Z" }] });
  const run: EvidenceInput["run"] = { id: 500, head_sha: C, conclusion: "success", html_url: RUN };

  it("several releases on different tags and commits are each kept with their own match; malformed ones are counted", () => {
    const e = releaseEvidence({
      repo,
      run,
      deployments: [],
      releases: [
        { release: rel(1, "v1.0.0"), tag: loaded(ref("v1.0.0", "commit", C)) },
        { release: rel(2, "v0.9.0"), tag: loaded(ref("v0.9.0", "commit", OTHER)) },
        { release: rel(3, "v1.0.0-rc.1", { prerelease: true }), tag: loaded(ref("v1.0.0-rc.1", "tag", T1), [tagObject(T1, "v1.0.0-rc.1", "commit", C)]) },
        { release: rel(4, "v1.1.0", { draft: true }), tag: { state: "not found" } },
        { release: { id: 5 }, tag: { state: "not loaded" } },
      ],
    });
    expect(e.releases.map((r) => [r.tag, r.commit.match, r.commit.resolvedSha?.slice(0, 7) ?? null, r.draft, r.prerelease])).toEqual([
      ["v1.0.0", "confirmed commit", "ccccccc", false, false],
      ["v0.9.0", "different commit", "ddddddd", false, false],
      ["v1.0.0-rc.1", "confirmed commit", "ccccccc", false, true],
      ["v1.1.0", "unknown", null, true, false],
    ]);
    expect(e.malformedReleases).toBe(1);
    expect(e.notes).toEqual([
      "The run succeeded, but GitHub lists no deployment of its commit: a successful run is not a deployment.",
      "1 release's tag was not resolved to a commit; how it relates to this commit is unknown.",
      "1 release was left out because GitHub's response lacked expected fields.",
    ]);
  });

  it("a release and a deployment of the same commit are related by commit only, never as 'the release was deployed'", () => {
    const e = releaseEvidence({
      repo,
      run,
      deployments: [dep(1, "env-a"), dep(2, "env-b", OTHER)],
      releases: [
        { release: rel(1, "v1.0.0"), tag: loaded(ref("v1.0.0", "commit", C)) },
        { release: rel(2, "v0.9.0"), tag: loaded(ref("v0.9.0", "commit", OTHER)) },
        { release: rel(3, "v1.0.1", { target_commitish: C }), tag: { state: "not loaded" } },
      ],
    });
    expect(e.releases[0]!.deployments).toEqual([{ id: 1, environment: "env-a", relation: "same commit", basis: "Same commit as this release; GitHub's data does not say whether this release was deployed." }]);
    // Another commit's release, and one only possibly on this commit, are not related to any deployment.
    expect(e.releases[1]!.deployments).toEqual([]);
    expect(e.releases[2]!.deployments).toEqual([]);
    // The deployment's own evidence is unchanged by releases.
    expect(e.deployments.map((d) => [d.id, d.association, d.outcome])).toEqual([[1, "confirmed", "succeeded"], [2, "conflicting", "succeeded"]]);
    expect(e.deployments[0]).not.toHaveProperty("release");
  });

  it("releases not loaded, or none confirmed for the commit", () => {
    expect(releaseEvidence({ repo, run, deployments: [], releases: null }).notes).toContain("Releases were not loaded.");
    expect(releaseEvidence({ repo, run, deployments: [], releases: [] }).notes).toContain("No release's tag is confirmed to point to this commit; not every deployment has a release.");
  });
});

describe("release notes for a report section of releases alone", () => {
  const run: EvidenceInput["run"] = { id: 500, head_sha: C, conclusion: "success", html_url: RUN };
  const NO_DEPLOYMENT = "The run succeeded, but GitHub lists no deployment of its commit: a successful run is not a deployment.";

  it("a deployment-only note stays with the deployments and is never among the release notes", () => {
    const input: EvidenceInput = { repo, run, deployments: [], releases: [{ release: rel(1, "v0.9.0"), tag: loaded(ref("v0.9.0", "commit", OTHER)) }] };
    // The shared summary holds both kinds of note (what the export used to copy into the releases section).
    expect(releaseEvidence(input).notes).toEqual([NO_DEPLOYMENT, "No release's tag is confirmed to point to this commit; not every deployment has a release."]);
    // The deployments section's notes (from the deployments alone) keep it.
    expect(releaseEvidence({ repo, run, deployments: [] }).notes).toEqual([NO_DEPLOYMENT]);
    expect(releaseNotes(input)).toEqual(["No release's tag is confirmed to point to this commit; not every deployment has a release."]);
  });

  it("'deployments were not loaded' is not a release note; release notes are kept whole and in order", () => {
    const input: EvidenceInput = {
      repo,
      run,
      deployments: null,
      releases: [
        { release: rel(1, "v1.0.0"), tag: loaded(ref("v1.0.0", "commit", C)) },
        { release: rel(4, "v1.1.0"), tag: { state: "not found" } },
        { release: { id: 5 }, tag: { state: "not loaded" } },
      ],
    };
    expect(releaseEvidence(input).notes[0]).toBe("Deployments were not loaded, so it is not known whether this commit was deployed.");
    expect(releaseNotes(input)).toEqual([
      "1 release's tag was not resolved to a commit; how it relates to this commit is unknown.",
      "1 release was left out because GitHub's response lacked expected fields.",
    ]);
  });

  it("an unknown commit concerns releases too; artifact notes are never release notes", () => {
    const unknown = releaseNotes({ repo, run: { ...run, head_sha: "" }, deployments: [], releases: [] });
    expect(unknown[0]).toBe("The run's commit is unknown, so nothing can be tied to it by commit.");
    expect(unknown).not.toContain(NO_DEPLOYMENT);
    expect(releaseNotes({ repo, run, deployments: [], releases: [], artifacts: null })).not.toContain("Artifacts were not loaded.");
  });
});
