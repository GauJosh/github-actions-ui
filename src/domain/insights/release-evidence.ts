// Release and deployment evidence for one workflow run: which GitHub deployments, releases and artifacts can be tied
// to it, and how strongly. Pure: no I/O; the inputs are GitHub REST responses (fields as GitHub documents them),
// loaded elsewhere. No environment names or pipeline order are assumed.
//
// What each source can establish:
// - Deployments (`GET /repos/{o}/{r}/deployments`) carry the deployed commit (`sha`), `ref`, `environment` and
//   times, but no workflow run id. A deployment of the run's exact commit in the same repository is a confirmed
//   COMMIT association; it is only a POSSIBLE association with this run (another run, or a tool outside Actions,
//   may have deployed the same commit).
// - Deployment statuses (`GET …/deployments/{id}/statuses`) carry the state and optional `target_url` / `log_url`.
//   Checked on public data (2026-10-25): statuses of deployments made by Actions environment jobs link both to
//   `https://github.com/{o}/{r}/actions/runs/{run}/job/{job}` on the run's host; deployments made by other tools
//   (a hosting provider's bot) link to that provider's site instead.
//   When one of those links to this run in this repository, and the commit also matches, the deployment is
//   confirmed for this run. A link to this run with a different commit is a conflict, reported as such.
// - Releases (`GET …/releases`) name a tag. `target_commitish` is only what the tag was created from when the tag
//   did not already exist, and is often a branch, so a release is tied to a commit only when its tag has been
//   resolved to a commit through the Git references API (release-tags.ts); otherwise it is at most possible.
// - Artifacts (`GET …/actions/runs/{id}/artifacts`) name their workflow run. Nothing in GitHub's data links an
//   artifact to a deployment or a release.
// Never used: closeness in time, branch names as commits, a run's success as a deployment's success.
import type { RepoRef, Run } from "../types";
import { artifactAssociation, NOT_LINKED_NOTE, type GitHubArtifact } from "./artifacts";
import type { DeploymentRecord } from "./deployments";
import { releaseOf, toRelease, type ReleaseEvidence, type TagLookup } from "./release-tags";

export type { GitHubRelease, ReleaseEvidence, TagLookup } from "./release-tags";
export type { GitHubArtifact } from "./artifacts";

export type GitHubDeployment = {
  id: number;
  sha?: string | null;
  ref?: string | null;
  task?: string | null;
  environment?: string | null;
  original_environment?: string | null;
  production_environment?: boolean;
  transient_environment?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};
/** Documented states, plus `waiting` (seen on live Actions environment deployments awaiting approval). */
export type GitHubDeploymentState = "error" | "failure" | "inactive" | "in_progress" | "queued" | "pending" | "waiting" | "success";
export type GitHubDeploymentStatus = {
  id: number;
  state: GitHubDeploymentState | string;
  environment?: string | null;
  target_url?: string | null;
  log_url?: string | null;
  created_at?: string | null;
};

/** How strongly an item is tied to the run. */
export type Association =
  /** GitHub's data ties it to this run (and, for deployments, to its commit). */
  | "confirmed"
  /** Tied to the run's commit only; this run is one possible source. */
  | "same commit"
  /** Some data points at the run and some away from it. */
  | "conflicting"
  /** The data needed to decide is missing. */
  | "unknown";

export type DeploymentOutcome = "succeeded" | "failed" | "in progress" | "pending" | "waiting" | "inactive" | "no status" | "statuses not loaded" | "unrecognised status";

export type DeploymentEvidence = {
  id: number;
  environment: string | null;
  sha: string | null;
  ref: string | null;
  association: Association;
  /** The facts behind the association, in words. */
  basis: string[];
  outcome: DeploymentOutcome;
  /** GitHub's own state of the latest status, kept as reported. */
  state?: string;
  createdAt?: string;
  statusAt?: string;
  /** A run this deployment's statuses link to, when it is another run of the repository. */
  linkedRunId?: number;
  /** Every other run of the repository its statuses link to. */
  otherRunIds?: number[];
  /** Jobs of this run its statuses link to (`…/actions/runs/{run}/job/{job}`). */
  linkedJobIds?: number[];
  production?: boolean;
};

export type ArtifactEvidence = { id: number; name: string; association: Association; expired: boolean; sizeInBytes?: number };

/** A source that was not loaded or could not be read is `null`; an empty list is a real answer. */
export type EvidenceInput = {
  repo: RepoRef;
  run: Pick<Run, "id" | "head_sha" | "conclusion" | "html_url">;
  deployments: { deployment: GitHubDeployment; statuses: GitHubDeploymentStatus[] | null }[] | null;
  /** Each release as GitHub returned it, with the lookups of its tag. */
  releases?: { release: unknown; tag: TagLookup }[] | null;
  artifacts?: GitHubArtifact[] | null;
};

export type ReleaseEvidenceSummary = {
  commit: string | null;
  /** Deployments tied to the run or its commit, or in conflict with it; deployments of other commits are counted only. */
  deployments: DeploymentEvidence[];
  otherCommits: number;
  /** Every loaded release, whatever its commit; each says how it relates to the commit, the run and deployments. */
  releases: ReleaseEvidence[];
  /** Releases left out because they lacked a numeric id or a tag name. */
  malformedReleases: number;
  artifacts: ArtifactEvidence[];
  /** What the evidence cannot say, or where it disagrees. */
  notes: string[];
};

const SHA = /^[0-9a-f]{40}$/i;
const fullSha = (s: string | null | undefined) => (s && SHA.test(s) ? s.toLowerCase() : null);
const sameRepo = (a: RepoRef, b: RepoRef) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

/** The run (and job, for `…/job/{id}`) a GitHub URL points to (`…/{owner}/{repo}/actions/runs/{id}[/…]`) on the run's own host, if any. */
export function linkedRun(url: string | null | undefined, host: string): { repo: RepoRef; runId: number; jobId?: number } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.host !== host) return null;
  const m = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?(?:\/|$)/.exec(u.pathname);
  return m ? { repo: { owner: m[1]!, repo: m[2]! }, runId: Number(m[3]), ...(m[4] && { jobId: Number(m[4]) }) } : null;
}

/** The latest status (by time, then id) decides the outcome; GitHub's own state is kept beside it. */
function outcomeOf(statuses: GitHubDeploymentStatus[] | null): { outcome: DeploymentOutcome; state?: string; at?: string } {
  if (statuses === null) return { outcome: "statuses not loaded" };
  if (!statuses.length) return { outcome: "no status" };
  const latest = [...statuses].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id)[0]!;
  const outcome: DeploymentOutcome =
    latest.state === "success"
      ? "succeeded"
      : latest.state === "failure" || latest.state === "error"
        ? "failed"
        : latest.state === "in_progress"
          ? "in progress"
          : latest.state === "queued" || latest.state === "pending"
            ? "pending"
            : latest.state === "waiting"
              ? "waiting"
              : latest.state === "inactive"
                ? "inactive"
                : "unrecognised status";
  return { outcome, state: latest.state, ...(latest.created_at && { at: latest.created_at }) };
}

function deployment(input: EvidenceInput, host: string, commit: string | null, d: GitHubDeployment, statuses: GitHubDeploymentStatus[] | null): DeploymentEvidence | "other commit" {
  const sha = fullSha(d.sha);
  const links = (statuses ?? []).flatMap((s) => [linkedRun(s.target_url, host), linkedRun(s.log_url, host)]).filter((l): l is NonNullable<typeof l> => l !== null && sameRepo(l.repo, input.repo));
  const toRun = links.some((l) => l.runId === input.run.id);
  const others = [...new Set(links.filter((l) => l.runId !== input.run.id).map((l) => l.runId))];
  const jobIds = [...new Set(links.flatMap((l) => (l.runId === input.run.id && l.jobId !== undefined ? [l.jobId] : [])))];
  const basis: string[] = [];
  let association: Association;
  if (!sha || !commit) {
    association = toRun ? "conflicting" : "unknown";
    basis.push(!sha ? "GitHub reported no full commit SHA for this deployment." : "The run's commit is unknown.");
    if (toRun) basis.push("A status links to this run, but the commits cannot be compared.");
  } else if (sha !== commit) {
    if (!toRun) return "other commit";
    association = "conflicting";
    basis.push(`A status links to this run, but the deployment is of commit ${sha.slice(0, 7)}, not the run's ${commit.slice(0, 7)}.`);
  } else if (toRun && others.length) {
    association = "conflicting";
    basis.push("Same commit; its statuses link to this run and to another run.");
  } else if (toRun) {
    association = "confirmed";
    basis.push("Same commit, and a deployment status links to this run.");
  } else {
    association = "same commit";
    basis.push(
      statuses === null
        ? "Same commit; its statuses could not be read, so whether they link to this run is unknown."
        : others.length
          ? "Same commit, but its statuses link to another run."
          : "Same commit; nothing links it to this run, so another run or tool may have created it.",
    );
  }
  const { outcome, state, at } = outcomeOf(statuses);
  const envs = new Set((statuses ?? []).map((s) => s.environment).filter((e): e is string => !!e));
  if (d.environment) envs.delete(d.environment);
  if (envs.size) basis.push(`Its statuses name another environment too: ${[...envs].join(", ")}.`);
  return {
    id: d.id,
    environment: d.environment ?? null,
    sha,
    ref: d.ref ?? null,
    association,
    basis,
    outcome,
    ...(state && { state }),
    ...(d.created_at && { createdAt: d.created_at }),
    ...(at && { statusAt: at }),
    ...(others.length === 1 && { linkedRunId: others[0] }),
    ...(others.length > 0 && { otherRunIds: others }),
    ...(jobIds.length > 0 && { linkedJobIds: jobIds }),
    ...(d.production_environment !== undefined && { production: d.production_environment }),
  };
}

export function releaseEvidence(input: EvidenceInput): ReleaseEvidenceSummary {
  const commit = fullSha(input.run.head_sha);
  let host = "";
  try {
    host = new URL(input.run.html_url).host;
  } catch {
    // Without the run's own URL, status links cannot be checked; they are then not used.
  }
  const notes: string[] = [];
  if (!commit) notes.push("The run's commit is unknown, so nothing can be tied to it by commit.");

  const deployments: DeploymentEvidence[] = [];
  let otherCommits = 0;
  if (input.deployments === null) notes.push("Deployments were not loaded, so it is not known whether this commit was deployed.");
  else {
    for (const { deployment: d, statuses } of input.deployments) {
      const e = deployment(input, host, commit, d, statuses);
      if (e === "other commit") otherCommits++;
      else deployments.push(e);
    }
    const tied = deployments.filter((d) => d.association === "confirmed" || d.association === "same commit");
    if (!tied.length) {
      notes.push(
        input.run.conclusion === "success"
          ? "The run succeeded, but GitHub lists no deployment of its commit: a successful run is not a deployment."
          : "GitHub lists no deployment of this run's commit.",
      );
    }
    const byEnv = new Map<string, number>();
    for (const d of tied) byEnv.set(d.environment ?? "", (byEnv.get(d.environment ?? "") ?? 0) + 1);
    for (const [env, n] of byEnv) if (n > 1) notes.push(`${n} deployments of this commit to ${env || "an unnamed environment"}; each is listed with its own status.`);
    if (deployments.some((d) => d.outcome === "statuses not loaded")) notes.push("Some deployments' statuses were not loaded or could not be read; their outcome is unknown.");
    if (!host && input.deployments.length) notes.push("The run's URL is unknown, so links in deployment statuses were not checked.");
  }

  let malformedReleases = 0;
  const releases = (input.releases ?? []).flatMap(({ release: raw, tag }) => {
    const r = toRelease(raw);
    if (!r) malformedReleases++;
    return r ? [releaseOf(commit, r, tag, deployments)] : [];
  });
  if (input.releases === null) notes.push("Releases were not loaded.");
  else if (input.releases) {
    if (!releases.some((r) => r.commit.match === "confirmed commit")) notes.push("No release's tag is confirmed to point to this commit; not every deployment has a release.");
    const open = releases.filter((r) => r.commit.match === "possible" || r.commit.match === "unknown").length;
    if (open) notes.push(`${open} release${open === 1 ? "'s tag was" : "s' tags were"} not resolved to a commit; how ${open === 1 ? "it relates" : "they relate"} to this commit is unknown.`);
    if (malformedReleases) notes.push(`${malformedReleases} release${malformedReleases === 1 ? " was" : "s were"} left out because GitHub's response lacked expected fields.`);
  }

  const artifacts = (input.artifacts ?? []).map((a): ArtifactEvidence => {
    // The same rule as the artifact evidence (artifacts.ts); never an attempt, a release or a deployment.
    const { association } = artifactAssociation(a, input.run);
    return { id: a.id, name: a.name, association, expired: Boolean(a.expired), ...(a.size_in_bytes !== undefined && { sizeInBytes: a.size_in_bytes }) };
  });
  if (input.artifacts === null) notes.push("Artifacts were not loaded.");
  if (artifacts.length) notes.push(NOT_LINKED_NOTE);

  return { commit, deployments, otherCommits, releases, malformedReleases, artifacts, notes };
}

// ---- job-environment records joined to GitHub deployments ------------------------------------------------------------
// A job-environment record (deploymentsOf) says which of this run's jobs use an environment; a GitHub deployment says
// which commit went to an environment. The same environment and commit make a deployment only a CANDIDATE for the
// record: another run or tool may have deployed the same commit there. A status link to this run confirms the run, not
// the job; only a status link naming one of the record's jobs (`…/runs/{run}/job/{job}`, as GitHub's Actions
// deployments do) ties it to that job. Environment names are compared without case (GitHub treats them so); nothing
// else about them is used, and no order between environments is assumed. Times are not used.

export type EnvironmentMatch =
  /** Same commit and environment, confirmed for this run, and its statuses link to exactly one of the record's jobs. */
  | "job linked"
  /** Same commit and environment and confirmed for this run, but no single job of the record is named. */
  | "run confirmed"
  /** Same commit and environment only; nothing ties it to this run or its jobs. */
  | "candidate"
  /** Same commit and environment, but its statuses link to another run. */
  | "another run"
  /** Its statuses link to this run, but other data disagrees. */
  | "conflicting"
  /** A commit is missing, so the two cannot be compared. */
  | "unknown";

export type EnvironmentJoin = {
  environment: string;
  provenance: DeploymentRecord["provenance"];
  /** The record's own outcome, from its jobs. */
  outcome: DeploymentRecord["outcome"];
  jobIds: number[];
  deployments: { id: number; match: EnvironmentMatch; jobId?: number; basis: string }[];
  /** Why no deployment is listed, when none is. */
  note?: string;
};

export type EnvironmentJoinSummary = {
  records: EnvironmentJoin[];
  /** Deployments of this commit that no job-environment record of the run names. */
  unmatched: { id: number; environment: string | null; basis: string }[];
};

const sameEnv = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function matchOf(r: DeploymentRecord, d: DeploymentEvidence): { match: EnvironmentMatch; jobId?: number; basis: string } | null {
  if (!d.environment || !sameEnv(d.environment, r.environment)) return null;
  const commit = fullSha(r.commit);
  if (d.association === "conflicting") return { match: "conflicting", basis: d.basis.join(" ") };
  if (!d.sha || !commit) return { match: "unknown", basis: "Same environment, but a full commit SHA is missing, so the commits cannot be compared." };
  if (d.sha !== commit) return null;
  if (d.association === "confirmed") {
    const linked = d.linkedJobIds ?? [];
    const own = linked.filter((id) => r.jobIds.includes(id));
    if (own.length === 1) return { match: "job linked", jobId: own[0]!, basis: `Its status links to job ${own[0]} of this run, which uses ${r.environment}.` };
    if (own.length > 1) return { match: "run confirmed", basis: `Its statuses link to ${own.length} of this run's jobs that use ${r.environment}, so which one created it is not known.` };
    return {
      match: "run confirmed",
      basis: linked.length
        ? `Its statuses link to job ${linked.join(", ")} of this run, which is not one of this attempt's jobs that use ${r.environment}.`
        : "Its statuses link to this run but name no job, so which job created it is not known.",
    };
  }
  if (d.association === "same commit") {
    if (d.otherRunIds?.length) return { match: "another run", basis: `Same commit and environment, but its statuses link to run ${d.otherRunIds.join(", ")}.` };
    return {
      match: "candidate",
      basis:
        d.outcome === "statuses not loaded"
          ? "Same commit and environment; its statuses could not be read, so whether they link to this run is unknown."
          : "Same commit and environment only; nothing links it to this run, so another run or tool may have created it.",
    };
  }
  return { match: "unknown", basis: d.basis.join(" ") };
}

/** Relates this run's job-environment records to GitHub's deployments of its commit; `evidence` null means not loaded. */
export function environmentJoin(records: DeploymentRecord[], evidence: Pick<ReleaseEvidenceSummary, "deployments"> | null): EnvironmentJoinSummary {
  const used = new Set<number>();
  const joined = records.map((r): EnvironmentJoin => {
    const deployments = (evidence?.deployments ?? []).flatMap((d) => {
      const m = matchOf(r, d);
      if (!m) return [];
      used.add(d.id);
      return [{ id: d.id, ...m }];
    });
    const base = { environment: r.environment, provenance: r.provenance, outcome: r.outcome, jobIds: r.jobIds, deployments };
    if (evidence === null) return { ...base, note: "GitHub deployments were not loaded." };
    return deployments.length ? base : { ...base, note: `This run's jobs use ${r.environment}, but GitHub lists no deployment of this commit to it.` };
  });
  const unmatched = (evidence?.deployments ?? [])
    .filter((d) => !used.has(d.id))
    .map((d) => ({
      id: d.id,
      environment: d.environment,
      basis: d.environment ? `No job-environment record of this run (declared or from an input) names ${d.environment}.` : "GitHub reported no environment for this deployment.",
    }));
  return { records: joined, unmatched };
}
