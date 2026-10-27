// GitHub Releases and the evidence tying each one to a workflow run's commit. Pure: no I/O; the inputs are GitHub REST
// responses, loaded elsewhere, kept as `unknown` until checked here.
//
// What each source can establish:
// - A release (`GET /repos/{o}/{r}/releases`) names a tag (`tag_name`). Its `target_commitish` is what the tag is
//   created from only when the tag does not already exist, and is often a branch, so it never proves a commit.
// - A tag ref (`GET /repos/{o}/{r}/git/ref/tags/{tag}`) points either at a commit (a lightweight tag) or at an
//   annotated tag object (`object.type: "tag"`), which `GET /repos/{o}/{r}/git/tags/{sha}` reads; that object may
//   point at another tag object in turn. Only a chain that ends at a commit resolves the release's commit.
// - Nothing in a release names a workflow run or a deployment. A release whose tag points at the run's commit shares
//   that commit; it was not necessarily created by this run, and sharing a commit with a deployment does not mean the
//   release was deployed.
import type { DeploymentEvidence } from "./release-evidence";

export type GitHubRelease = {
  id: number;
  tag_name: string;
  name?: string | null;
  target_commitish?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  created_at?: string | null;
  published_at?: string | null;
  html_url?: string | null;
};

/** The tag lookups made for one release; raw responses are checked by `resolveTag`. */
export type TagLookup =
  /** Not requested. */
  | { state: "not loaded" }
  /** The ref request failed (network, rate limit, server error): the tag's existence is unknown. */
  | { state: "failed"; why: string }
  /** GitHub answered 404 for the ref: no such tag. */
  | { state: "not found" }
  /** The ref response, and the annotated tag objects read after it (any order). */
  | { state: "loaded"; ref: unknown; tagObjects?: unknown[] };

export type TagResolution =
  | { kind: "commit"; sha: string; via: "lightweight tag" | "annotated tag"; depth: number }
  | { kind: "unresolved"; reason: string; conflicting?: boolean };

export type ReleaseCommitMatch =
  /** The tag was resolved through the Git references API to exactly the run's commit. */
  | "confirmed commit"
  /** Metadata suggests the run's commit, but the tag was not resolved. */
  | "possible"
  /** The tag was resolved to another commit. */
  | "different commit"
  /** The tag or the run's commit could not be resolved, or data is missing. */
  | "unknown"
  /** GitHub's responses disagree with each other. */
  | "conflicting";

export type ReleaseEvidence = {
  id: number;
  tag: string;
  name?: string;
  url?: string;
  draft: boolean;
  prerelease: boolean;
  createdAt?: string;
  publishedAt?: string;
  /** Release to commit: how the release's tag relates to the run's commit. */
  commit: { match: ReleaseCommitMatch; resolvedSha?: string; via?: "lightweight tag" | "annotated tag"; basis: string[] };
  /** Release to run: GitHub's release data never names a run, so at most the commit is shared. */
  run: { relation: "shares the run's commit" | "not established"; basis: string };
  /** Release to deployment: deployments of the same commit, which says nothing about whether this release was deployed. */
  deployments: { id: number; environment: string | null; relation: "same commit"; basis: string }[];
};

/** How many annotated tag objects are followed before giving up (git allows tags of tags). */
export const MAX_TAG_DEPTH = 5;

const SHA = /^[0-9a-f]{40}$/i;
const fullSha = (s: unknown) => (typeof s === "string" && SHA.test(s) ? s.toLowerCase() : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Release fields the model uses, from GitHub's documented response; an item without a numeric id or a tag is left out. */
export function toRelease(v: unknown): GitHubRelease | null {
  if (!isRecord(v) || typeof v.id !== "number" || typeof v.tag_name !== "string" || !v.tag_name) return null;
  return {
    id: v.id,
    tag_name: v.tag_name,
    name: text(v.name) ?? null,
    target_commitish: text(v.target_commitish) ?? null,
    draft: v.draft === true,
    prerelease: v.prerelease === true,
    created_at: text(v.created_at) ?? null,
    published_at: text(v.published_at) ?? null,
    html_url: text(v.html_url) ?? null,
  };
}

/** Follows a tag ref, through annotated tag objects, to the commit it names. */
export function resolveTag(tagName: string, lookup: TagLookup, maxDepth = MAX_TAG_DEPTH): TagResolution {
  if (lookup.state === "not loaded") return { kind: "unresolved", reason: "Its tag was not looked up." };
  if (lookup.state === "failed") return { kind: "unresolved", reason: `Its tag could not be looked up (${lookup.why}).` };
  if (lookup.state === "not found") return { kind: "unresolved", reason: `GitHub has no tag ${tagName}.` };
  const ref = lookup.ref;
  if (!isRecord(ref) || typeof ref.ref !== "string" || !isRecord(ref.object)) return { kind: "unresolved", reason: "GitHub's tag reference response lacked expected fields." };
  if (ref.ref !== `refs/tags/${tagName}`) return { kind: "unresolved", reason: `GitHub returned ${ref.ref} for tag ${tagName}.`, conflicting: true };
  let type = ref.object.type;
  let sha = fullSha(ref.object.sha);
  if (!sha) return { kind: "unresolved", reason: "Its tag reference names no full SHA." };
  const objects = new Map<string, Record<string, unknown>>();
  for (const o of lookup.tagObjects ?? []) {
    const s = isRecord(o) ? fullSha(o.sha) : null;
    if (s) objects.set(s, o as Record<string, unknown>);
  }
  const seen = new Set<string>();
  let depth = 0;
  while (type === "tag") {
    if (seen.has(sha)) return { kind: "unresolved", reason: "Its annotated tags point at each other in a loop." };
    if (depth >= maxDepth) return { kind: "unresolved", reason: `More than ${maxDepth} annotated tags in a chain; not followed further.` };
    seen.add(sha);
    const o = objects.get(sha);
    if (!o) return { kind: "unresolved", reason: `Annotated tag object ${sha.slice(0, 7)} was not loaded.` };
    if (!isRecord(o.object)) return { kind: "unresolved", reason: "GitHub's tag object response lacked expected fields." };
    // The outermost tag object's own name should be the release's tag; a different name means the sources disagree.
    if (depth === 0 && typeof o.tag === "string" && o.tag !== tagName) {
      return { kind: "unresolved", reason: `Tag ref ${tagName} points at an annotated tag named ${o.tag}.`, conflicting: true };
    }
    depth++;
    type = o.object.type;
    sha = fullSha(o.object.sha);
    if (!sha) return { kind: "unresolved", reason: "An annotated tag object names no full SHA." };
  }
  if (type !== "commit") return { kind: "unresolved", reason: `Its tag points at a ${typeof type === "string" ? type : "object of unknown type"}, not a commit.` };
  return { kind: "commit", sha, via: depth ? "annotated tag" : "lightweight tag", depth };
}

/** One release against the run's commit (`null`: unknown) and the deployments of that commit. */
export function releaseOf(runCommit: string | null, r: GitHubRelease, lookup: TagLookup, deployments: DeploymentEvidence[] = []): ReleaseEvidence {
  const resolution = resolveTag(r.tag_name, lookup);
  const target = fullSha(r.target_commitish);
  const basis: string[] = [];
  let match: ReleaseCommitMatch;
  let resolvedSha: string | undefined;
  let via: "lightweight tag" | "annotated tag" | undefined;
  if (resolution.kind === "commit") {
    resolvedSha = resolution.sha;
    via = resolution.via;
    if (!runCommit) {
      match = "unknown";
      basis.push(`Its tag points to ${resolution.sha.slice(0, 7)}, but the run's commit is unknown.`);
    } else if (resolution.sha === runCommit) {
      match = "confirmed commit";
      basis.push(`Its ${resolution.via} points to the run's commit.`);
    } else {
      match = "different commit";
      basis.push(`Its ${resolution.via} points to ${resolution.sha.slice(0, 7)}, not the run's ${runCommit.slice(0, 7)}.`);
    }
    // target_commitish is ignored by GitHub once the tag exists; the tag decides, and the difference is only noted.
    if (target && target !== resolution.sha) basis.push(`Its target_commitish names ${target.slice(0, 7)}, which GitHub uses only when it creates the tag; the tag decides.`);
  } else if (resolution.conflicting) {
    match = "conflicting";
    basis.push(resolution.reason);
  } else {
    const tagMissing = lookup.state === "not found";
    const possible = runCommit && target === runCommit && (!tagMissing || r.draft);
    match = possible ? "possible" : "unknown";
    basis.push(resolution.reason);
    if (tagMissing && r.draft) basis.push("A draft release's tag may not exist until the release is published.");
    if (possible) basis.push("Its target_commitish names the run's commit, but that is not proof: GitHub ignores it when the tag already exists.");
  }
  const tied = match === "confirmed commit" ? deployments.filter((d) => d.sha === runCommit) : [];
  return {
    id: r.id,
    tag: r.tag_name,
    ...(r.name && { name: r.name }),
    ...(r.html_url && { url: r.html_url }),
    draft: Boolean(r.draft),
    prerelease: Boolean(r.prerelease),
    ...(r.created_at && { createdAt: r.created_at }),
    ...(r.published_at && { publishedAt: r.published_at }),
    commit: { match, ...(resolvedSha && { resolvedSha }), ...(via && { via }), basis },
    run:
      match === "confirmed commit"
        ? { relation: "shares the run's commit", basis: "GitHub's release data names no workflow run, so this run did not necessarily create or publish it." }
        : { relation: "not established", basis: "GitHub's release data names no workflow run, and its tag is not confirmed to point to the run's commit." },
    deployments: tied.map((d) => ({
      id: d.id,
      environment: d.environment,
      relation: "same commit",
      basis: "Same commit as this release; GitHub's data does not say whether this release was deployed.",
    })),
  };
}
