// Artifact evidence for one workflow run, from GitHub's run-scoped listing (`GET …/actions/runs/{id}/artifacts`).
// Pure: no I/O; the listing is loaded by src/runs/artifacts.ts.
//
// What GitHub's artifact metadata can establish (docs.github.com/en/rest/actions/artifacts):
// - `workflow_run.id` names the run the artifact belongs to. Equal to the selected run: confirmed for that RUN.
//   A `workflow_run.head_sha` that differs from the run's full commit is a conflict, whatever the id says.
// - No field names a run ATTEMPT, and the endpoint takes none: artifacts are listed for the whole run. An artifact
//   is never attributed to an attempt; creation times are not used to guess one. When the run's latest snapshot is
//   completed with `run_attempt === 1`, the listing may say only that the run had a single attempt when checked.
// - `workflow_run` may be missing or null: the artifact was still returned by the run-scoped endpoint, but its own
//   metadata does not confirm the run.
// - `expired: true` is metadata only; nothing is downloaded (`archive_download_url` is never requested).
// - An empty listing says only that GitHub lists none now: artifacts expire and can be deleted.
// - Nothing in GitHub's data links an artifact to a release or a deployment; names, file names, times and commit
//   equality are never used to suggest one.

/** An artifact as GitHub documents it; only the fields used here. */
export type GitHubArtifact = {
  id: number;
  name: string;
  size_in_bytes?: number;
  expired?: boolean;
  digest?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  expires_at?: string | null;
  workflow_run?: { id?: number; repository_id?: number; head_repository_id?: number; head_branch?: string | null; head_sha?: string } | null;
};

/** How an artifact's own metadata relates to the selected run. */
export type ArtifactAssociation =
  /** `workflow_run.id` is the selected run, and no supplied commit disagrees. Says nothing about the attempt. */
  | "confirmed"
  /** `workflow_run` names another run, or another commit. */
  | "conflicting"
  /** `workflow_run` (or its id) is missing: listed for the run, but not confirmed by the artifact's metadata. */
  | "unknown";

export type ArtifactRecord = {
  id: number;
  name: string;
  association: ArtifactAssociation;
  basis: string;
  /** As GitHub reports it; an expired artifact is metadata only. */
  expired: boolean;
  sizeInBytes: number;
  createdAt?: string;
  expiresAt?: string;
  /** GitHub's digest of the stored archive, as reported. Integrity metadata, not provenance. */
  digest?: string;
  /** Another run `workflow_run` names, when it conflicts. */
  otherRunId?: number;
};

/** A listing as the loader read it. */
export type ArtifactListing = {
  /** Items as GitHub returned them, one per artifact id (malformed items included, so they are counted). */
  items: unknown[];
  /** `total_count` of the last page read. */
  totalCount: number;
  /** GitHub lists another page after the last one read. */
  morePages: boolean;
};

export type ArtifactRunSnapshot = { id: number; head_sha: string; status: string; run_attempt: number };

export type ArtifactSummary = {
  /**
   * not loaded: nothing requested. none listed: GitHub lists no artifact now (not "none was ever uploaded").
   * complete: every listed artifact was read. incomplete: GitHub lists more than were read.
   */
  listing: "not loaded" | "none listed" | "complete" | "incomplete";
  artifacts: ArtifactRecord[];
  /** Valid artifacts read, malformed items left out, and GitHub's own count. */
  read: number;
  malformed: number;
  totalCount: number | null;
  /** Artifacts always belong to the run, never to an attempt; `single attempt` only qualifies that. */
  attempt: "single attempt when checked" | "whole run";
  /** The run has not completed: more artifacts may still be uploaded. */
  inProgress: boolean;
  notes: string[];
};

export const NOT_LINKED_NOTE = "GitHub does not link artifacts to deployments or releases; artifacts are listed for the run only.";
export const SINGLE_ATTEMPT_NOTE = "The run had a single attempt when checked.";
export const WHOLE_RUN_NOTE = "Artifacts are listed for the whole run; GitHub does not say which attempt uploaded each one.";

const SHA = /^[0-9a-f]{40}$/i;
const fullSha = (s: string | null | undefined) => (s && SHA.test(s) ? s.toLowerCase() : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional = (v: unknown, type: "string" | "number") => v === undefined || v === null || typeof v === type;

/**
 * An artifact with the fields GitHub documents as required and this model uses (`id`, `name`, `size_in_bytes`,
 * `expired`), and well-typed optional fields; otherwise null (counted as malformed, never shown as confirmed).
 */
export function toArtifact(raw: unknown): GitHubArtifact | null {
  if (!isRecord(raw)) return null;
  const { id, name, size_in_bytes, expired, workflow_run: wr } = raw;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || typeof name !== "string" || !name) return null;
  if (typeof size_in_bytes !== "number" || typeof expired !== "boolean") return null;
  if (!["digest", "created_at", "updated_at", "expires_at"].every((k) => optional(raw[k], "string"))) return null;
  if (wr !== undefined && wr !== null && (!isRecord(wr) || !optional(wr.id, "number") || !optional(wr.head_sha, "string"))) return null;
  return raw as GitHubArtifact;
}

/** The one rule tying an artifact to a run, shared with the release evidence (release-evidence.ts). */
export function artifactAssociation(a: Pick<GitHubArtifact, "workflow_run">, run: { id: number; head_sha: string }): { association: ArtifactAssociation; basis: string; otherRunId?: number } {
  const runId = a.workflow_run?.id ?? undefined;
  if (runId === undefined) {
    return { association: "unknown", basis: "Listed for this run, but the artifact's metadata names no workflow run, so it does not confirm the run itself." };
  }
  if (runId !== run.id) return { association: "conflicting", basis: `Listed for this run, but the artifact's metadata names run ${runId}.`, otherRunId: runId };
  const sha = fullSha(a.workflow_run?.head_sha);
  const commit = fullSha(run.head_sha);
  if (sha && commit && sha !== commit) {
    return { association: "conflicting", basis: `The artifact's metadata names this run, but commit ${sha.slice(0, 7)}, not the run's ${commit.slice(0, 7)}.` };
  }
  return {
    association: "confirmed",
    basis: sha && commit ? "The artifact's metadata names this run and its commit." : "The artifact's metadata names this run; its commit was not compared.",
  };
}

function recordOf(a: GitHubArtifact, run: ArtifactRunSnapshot): ArtifactRecord {
  const { association, basis, otherRunId } = artifactAssociation(a, run);
  return {
    id: a.id,
    name: a.name,
    association,
    basis,
    expired: a.expired === true,
    sizeInBytes: a.size_in_bytes ?? 0,
    ...(a.created_at && { createdAt: a.created_at }),
    ...(a.expires_at && { expiresAt: a.expires_at }),
    ...(a.digest && { digest: a.digest }),
    ...(otherRunId !== undefined && { otherRunId }),
  };
}

/**
 * Artifact evidence for a run. `run` is the run's LATEST snapshot (GitHub's run endpoint without an attempt): an
 * earlier attempt's snapshot reports that attempt's number, which would wrongly look like a single-attempt run.
 * `viewedAttempt` is the attempt on screen, when it is not the latest. `listing` null means not loaded.
 */
export function artifactEvidence(input: { run: ArtifactRunSnapshot; viewedAttempt?: number; listing: ArtifactListing | null }): ArtifactSummary {
  const { run, viewedAttempt, listing } = input;
  const inProgress = run.status !== "completed";
  const single = !inProgress && run.run_attempt === 1 && (viewedAttempt === undefined || viewedAttempt === 1);
  const attempt = single ? "single attempt when checked" : "whole run";
  const notes: string[] = [single ? SINGLE_ATTEMPT_NOTE : WHOLE_RUN_NOTE];
  if (!single && run.run_attempt > 1) {
    notes.push(
      viewedAttempt !== undefined && viewedAttempt !== run.run_attempt
        ? `You are viewing attempt ${viewedAttempt} of ${run.run_attempt}; these artifacts are not shown as belonging to it.`
        : `The run has ${run.run_attempt} attempts; none of these artifacts is shown as belonging to a particular one.`,
    );
  }
  if (inProgress) notes.push("The run has not completed, so more artifacts may still be uploaded.");

  if (listing === null) {
    return { listing: "not loaded", artifacts: [], read: 0, malformed: 0, totalCount: null, attempt, inProgress, notes: ["Artifacts were not loaded.", ...notes] };
  }
  let malformed = 0;
  const artifacts = listing.items.flatMap((raw) => {
    const a = toArtifact(raw);
    if (!a) malformed++;
    return a ? [recordOf(a, run)] : [];
  });
  const seen = listing.items.length;
  const state: ArtifactSummary["listing"] =
    seen === 0 && listing.totalCount === 0 && !listing.morePages ? "none listed" : listing.morePages || seen < listing.totalCount ? "incomplete" : "complete";

  if (state === "none listed") notes.push("GitHub lists no artifacts for this run now. That does not mean none was uploaded: artifacts expire and can be deleted.");
  if (state === "incomplete") notes.push(`${seen} of ${Math.max(listing.totalCount, seen)} artifacts GitHub lists for this run were read.`);
  if (state === "complete" && seen > listing.totalCount) notes.push(`GitHub's count (${listing.totalCount}) is lower than the ${seen} artifacts read; the listing changed while it was read.`);
  if (malformed) notes.push(`${malformed} listed item${malformed === 1 ? " was" : "s were"} left out because GitHub's response lacked expected fields.`);
  const expired = artifacts.filter((a) => a.expired).length;
  if (expired) notes.push(`${expired} expired artifact${expired === 1 ? " is" : "s are"} shown as metadata only; ${expired === 1 ? "it" : "they"} can no longer be downloaded.`);
  const unknown = artifacts.filter((a) => a.association === "unknown").length;
  if (unknown) notes.push(`${unknown} artifact${unknown === 1 ? "'s" : "s'"} metadata names no workflow run; listed for this run, but not confirmed by ${unknown === 1 ? "its" : "their"} own data.`);
  const conflicting = artifacts.filter((a) => a.association === "conflicting").length;
  if (conflicting) notes.push(`${conflicting} artifact${conflicting === 1 ? "'s" : "s'"} metadata disagrees with this run.`);
  if (artifacts.length) notes.push(NOT_LINKED_NOTE);
  return { listing: state, artifacts, read: artifacts.length, malformed, totalCount: listing.totalCount, attempt, inProgress, notes };
}
