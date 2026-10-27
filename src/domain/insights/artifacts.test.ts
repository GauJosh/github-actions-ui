// Artifact evidence (SYNTHETIC runs, commits and artifacts).
import { describe, expect, it } from "vitest";
import { artifactAssociation, artifactEvidence, NOT_LINKED_NOTE, SINGLE_ATTEMPT_NOTE, toArtifact, WHOLE_RUN_NOTE, type ArtifactRunSnapshot } from "./artifacts";

const C = "c".repeat(40);
const OTHER = "d".repeat(40);
const run: ArtifactRunSnapshot = { id: 500, head_sha: C, status: "completed", run_attempt: 1 };
const artifact = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  node_id: `synthetic-${id}`,
  name: `synthetic-artifact-${id}`,
  size_in_bytes: 1000 + id,
  url: `https://api.example.test/artifacts/${id}`,
  archive_download_url: `https://api.example.test/artifacts/${id}/zip`,
  expired: false,
  created_at: "2026-10-20T10:00:00Z",
  expires_at: "2027-01-18T10:00:00Z",
  workflow_run: { id: 500, repository_id: 1, head_repository_id: 1, head_branch: "main", head_sha: C },
  ...extra,
});
const listing = (items: unknown[], totalCount = items.length, morePages = false) => ({ items, totalCount, morePages });
const evidence = (items: unknown[], opts: { run?: Partial<ArtifactRunSnapshot>; viewedAttempt?: number; totalCount?: number; morePages?: boolean } = {}) =>
  artifactEvidence({ run: { ...run, ...opts.run }, viewedAttempt: opts.viewedAttempt, listing: listing(items, opts.totalCount, opts.morePages) });

describe("artifact association", () => {
  it("confirms the run only when workflow_run.id is the selected run, and a supplied commit agrees", () => {
    const e = evidence([artifact(1), artifact(2, { workflow_run: { id: 500 } }), artifact(3, { workflow_run: { id: 500, head_sha: "abc1234" } })]);
    expect(e.artifacts.map((a) => [a.id, a.association, a.basis])).toEqual([
      [1, "confirmed", "The artifact's metadata names this run and its commit."],
      [2, "confirmed", "The artifact's metadata names this run; its commit was not compared."],
      [3, "confirmed", "The artifact's metadata names this run; its commit was not compared."],
    ]);
    expect(e.listing).toBe("complete");
    expect(e.notes).toContain(NOT_LINKED_NOTE);
  });

  it("a different run id, or the same run with another commit, is conflicting, never confirmed", () => {
    const e = evidence([artifact(1, { workflow_run: { id: 777, head_sha: C } }), artifact(2, { workflow_run: { id: 500, head_sha: OTHER } }), artifact(3, { workflow_run: { id: 500, head_sha: C.toUpperCase() } })]);
    expect(e.artifacts.map((a) => [a.id, a.association, a.otherRunId])).toEqual([
      [1, "conflicting", 777],
      [2, "conflicting", undefined],
      [3, "confirmed", undefined],
    ]);
    expect(e.artifacts[1]!.basis).toBe("The artifact's metadata names this run, but commit ddddddd, not the run's ccccccc.");
    expect(e.notes).toContain("2 artifacts' metadata disagrees with this run.");
  });

  it("a missing or null workflow_run keeps the artifact, listed for the run but not confirmed by its own metadata", () => {
    const e = evidence([artifact(1, { workflow_run: null }), artifact(2, { workflow_run: undefined }), artifact(3, { workflow_run: {} })]);
    expect(e.artifacts.map((a) => a.association)).toEqual(["unknown", "unknown", "unknown"]);
    expect(e.artifacts[0]!.basis).toBe("Listed for this run, but the artifact's metadata names no workflow run, so it does not confirm the run itself.");
    expect(e.notes).toContain("3 artifacts' metadata names no workflow run; listed for this run, but not confirmed by their own data.");
  });

  it("uses no names, times or commit equality alone", () => {
    // Same commit and a release-like name, but another run: still conflicting, and nothing about releases is claimed.
    expect(artifactAssociation({ workflow_run: { id: 1, head_sha: C } }, run).association).toBe("conflicting");
    const e = evidence([artifact(1, { name: "release-v1.4.0", workflow_run: null })]);
    expect(e.artifacts[0]!.association).toBe("unknown");
    expect(e.notes.join(" ")).not.toMatch(/released|deployed/);
  });
});

describe("attempts", () => {
  it("a completed run with one attempt is qualified, never attributed to attempt 1", () => {
    const e = evidence([artifact(1)]);
    expect(e.attempt).toBe("single attempt when checked");
    expect(e.notes[0]).toBe(SINGLE_ATTEMPT_NOTE);
    expect(JSON.stringify(e)).not.toMatch(/from attempt|attempt 1\b/);
    expect(e.artifacts[0]).not.toHaveProperty("attempt");
  });

  it("a re-run lists artifacts for the whole run, also when an earlier attempt is viewed", () => {
    const latest = evidence([artifact(1)], { run: { run_attempt: 2 } });
    expect(latest.attempt).toBe("whole run");
    expect(latest.notes.slice(0, 2)).toEqual([WHOLE_RUN_NOTE, "The run has 2 attempts; none of these artifacts is shown as belonging to a particular one."]);
    const earlier = evidence([artifact(1)], { run: { run_attempt: 3 }, viewedAttempt: 1 });
    expect(earlier.attempt).toBe("whole run");
    expect(earlier.notes[1]).toBe("You are viewing attempt 1 of 3; these artifacts are not shown as belonging to it.");
    // An inconsistent view (an attempt beyond the latest) is never qualified as a single attempt.
    expect(evidence([], { viewedAttempt: 2 }).attempt).toBe("whole run");
  });

  it("a run in progress is not qualified, even at attempt 1, and may still upload artifacts", () => {
    const e = evidence([], { run: { status: "in_progress" } });
    expect(e).toMatchObject({ attempt: "whole run", inProgress: true, listing: "none listed" });
    expect(e.notes).toContain("The run has not completed, so more artifacts may still be uploaded.");
  });
});

describe("listing states", () => {
  it("not loaded is not an empty listing", () => {
    const e = artifactEvidence({ run, listing: null });
    expect(e).toMatchObject({ listing: "not loaded", totalCount: null, artifacts: [] });
    expect(e.notes[0]).toBe("Artifacts were not loaded.");
  });

  it("an empty listing does not claim that no artifact was ever uploaded", () => {
    const e = evidence([]);
    expect(e.listing).toBe("none listed");
    expect(e.notes).toContain("GitHub lists no artifacts for this run now. That does not mean none was uploaded: artifacts expire and can be deleted.");
    expect(e.notes).not.toContain(NOT_LINKED_NOTE);
  });

  it("expired artifacts are metadata only, with their expiry kept as reported", () => {
    const e = evidence([artifact(1, { expired: true, expires_at: "2026-09-01T00:00:00Z", digest: "sha256:" + "0".repeat(64) }), artifact(2)]);
    expect(e.artifacts[0]).toMatchObject({ expired: true, expiresAt: "2026-09-01T00:00:00Z", association: "confirmed", digest: "sha256:" + "0".repeat(64) });
    expect(e.notes).toContain("1 expired artifact is shown as metadata only; it can no longer be downloaded.");
    // Only metadata is kept: no download URL is carried into the evidence.
    expect(JSON.stringify(e)).not.toContain("zip");
  });

  it("counts malformed records instead of presenting them", () => {
    const e = evidence([artifact(1), { id: "2", name: "x", size_in_bytes: 1, expired: false }, { id: 3, name: "", size_in_bytes: 1, expired: false }, artifact(4, { expired: "no" }), artifact(5, { size_in_bytes: undefined }), artifact(6, { workflow_run: { id: "500" } }), artifact(7, { workflow_run: "500" }), null, 42]);
    expect(e.artifacts.map((a) => a.id)).toEqual([1]);
    expect(e).toMatchObject({ read: 1, malformed: 8, listing: "complete" });
    expect(e.notes).toContain("8 listed items were left out because GitHub's response lacked expected fields.");
    expect(toArtifact(artifact(9, { digest: null, workflow_run: null }))).not.toBeNull();
  });

  it("a listing cut by the page cap, or short of total_count, is incomplete", () => {
    const items = [artifact(1), artifact(2)];
    expect(evidence(items, { totalCount: 250, morePages: true })).toMatchObject({ listing: "incomplete", totalCount: 250, read: 2 });
    expect(evidence(items, { totalCount: 250, morePages: true }).notes).toContain("2 of 250 artifacts GitHub lists for this run were read.");
    expect(evidence(items, { totalCount: 3 }).listing).toBe("incomplete");
    // GitHub counts artifacts not yet read: not an empty listing.
    expect(evidence([], { totalCount: 2 }).listing).toBe("incomplete");
  });

  it("a count lower than the items read is complete, with a note that the listing changed", () => {
    const e = evidence([artifact(1), artifact(2)], { totalCount: 1 });
    expect(e.listing).toBe("complete");
    expect(e.notes).toContain("GitHub's count (1) is lower than the 2 artifacts read; the listing changed while it was read.");
  });
});
