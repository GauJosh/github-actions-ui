// GitHub releases of the run's repository, with a bounded number of their tags resolved per action, for the release
// evidence model. Read-only (GET). `loadReleases` lists the first page (30, newest first) and resolves one batch;
// `loadMoreReleases` resolves the next batch of releases not looked up yet, listing the next page first when every
// loaded release has been looked up. Each action makes at most `tags` lookups and `requests` tag requests (refs and
// annotated tag objects), `concurrency` at once.
//
// Which tags are resolved: GitHub's REST API has no cheap "tags at this commit" call, so releases whose
// `target_commitish` is the run's full SHA come first, then the rest in listing order, drafts last (their tag may not
// exist yet). Releases beyond the cap keep `{ state: "not loaded" }` ("not looked up yet"); the model then calls them
// possible or unknown. A release whose tag was already looked up (same release id, or another release with the same
// tag) is never looked up again.
//
// A 404 is reported by the client as "not found or no permission". It is taken as "no such tag" only because the
// releases listing of the same repository succeeded, which needs the same read access as the Git references API.
// Every other failure (rate limit, authorization, server or network error, an unreadable body) is a failed lookup.
import { MAX_TAG_DEPTH, toRelease, type TagLookup } from "../domain/insights/release-tags";
import type { EvidenceInput } from "../domain/insights/release-evidence";
import type { RepoRef, Run } from "../domain/types";
import { GitHubError, type GitHubClient } from "../github/client";

export const RELEASE_LIMITS = { tags: 10, requests: 20, concurrency: 2 };

export type LoadedReleases = {
  releases: NonNullable<EvidenceInput["releases"]>;
  /** Listing pages read so far. */
  pages: number;
  /** GitHub lists another page of releases after the last one read. */
  moreReleases: boolean;
  /** Valid releases whose tags have not been looked up yet. */
  unresolved: number;
  /** Tag lookups that failed for a reason other than "no such tag", over all actions. */
  failed: { tag: string; why: string }[];
  /** Tag requests made by the last action (refs and tag objects). */
  requests: number;
  /** Tag requests made over all actions. */
  totalRequests: number;
  /** Stopped by the abort signal; the result is partial and must not be shown. */
  cancelled: boolean;
};

type Client = Pick<GitHubClient, "listReleases" | "getTagRef" | "getTagObject">;

const SHA = /^[0-9a-f]{40}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const why = (error: unknown) => (error instanceof GitHubError ? error.failure.kind : error instanceof SyntaxError ? "unreadable response" : error instanceof Error ? error.message : "request failed");
const missing = (error: unknown) => error instanceof GitHubError && error.failure.kind === "not-found-or-no-permission";

async function listPage(client: Client, repo: RepoRef, page: number) {
  const listed = await client.listReleases(repo, page);
  if (!Array.isArray(listed.releases)) throw new Error("GitHub's releases response was not a list.");
  return { items: listed.releases as unknown[], hasNext: listed.hasNext };
}

/** Appends listed items, leaving out releases already held (by id): pages can shift when releases are published. */
function append(releases: LoadedReleases["releases"], items: unknown[]): LoadedReleases["releases"] {
  const held = new Set(releases.flatMap((r) => (isRecord(r.release) && typeof r.release.id === "number" ? [r.release.id] : [])));
  const added = items.flatMap((raw) => {
    const release = toRelease(raw);
    if (release && held.has(release.id)) return [];
    if (release) held.add(release.id);
    // Malformed items are passed on as returned, so the model counts them; they are never looked up.
    return [{ release: (release ?? raw) as unknown, tag: { state: "not loaded" } as TagLookup }];
  });
  return [...releases, ...added];
}

/** Resolves up to `limits.tags` releases not looked up yet; returns new entries, never changing `releases`. */
async function resolveBatch(client: Client, repo: RepoRef, run: Pick<Run, "head_sha">, releases: LoadedReleases["releases"], signal: AbortSignal | undefined, limits: typeof RELEASE_LIMITS) {
  const commit = SHA.test(run.head_sha) ? run.head_sha.toLowerCase() : null;
  const out = releases.map((r) => ({ ...r }));
  // Tags already looked up (by any release) are reused, never requested again.
  const known = new Map<string, TagLookup>();
  for (const r of out) {
    const v = toRelease(r.release);
    if (v && r.tag.state !== "not loaded") known.set(v.tag_name, r.tag);
  }
  for (const r of out) {
    const v = toRelease(r.release);
    if (v && r.tag.state === "not loaded" && known.has(v.tag_name)) r.tag = known.get(v.tag_name)!;
  }

  const rank = (v: NonNullable<ReturnType<typeof toRelease>>) => (commit && v.target_commitish?.toLowerCase() === commit ? 0 : v.draft ? 2 : 1);
  const waiting = out
    .map((r, i) => ({ r, i, v: toRelease(r.release) }))
    .filter((x): x is typeof x & { v: NonNullable<typeof x.v> } => x.v !== null && x.r.tag.state === "not loaded")
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i);
  // One lookup per tag name: releases sharing a tag share its result.
  const tags = [...new Set(waiting.map((x) => x.v.tag_name))].slice(0, limits.tags);

  const failed: LoadedReleases["failed"] = [];
  let requests = 0;
  let cancelled = false;
  const budget = () => requests < limits.requests;
  const stop = () => (signal?.aborted ? ((cancelled = true), true) : false);

  async function lookup(tag: string): Promise<TagLookup | null> {
    if (stop() || !budget()) return null;
    requests++;
    let ref: unknown;
    try {
      ref = await client.getTagRef(repo, tag);
    } catch (error) {
      if (missing(error)) return { state: "not found" };
      failed.push({ tag, why: why(error) });
      return { state: "failed", why: why(error) };
    }
    // Follow annotated tag objects as far as the model would (loops and depth are judged by resolveTag).
    const tagObjects: unknown[] = [];
    const seen = new Set<string>();
    let next = isRecord(ref) && isRecord(ref.object) ? ref.object : null;
    while (next && next.type === "tag" && typeof next.sha === "string" && SHA.test(next.sha) && !seen.has(next.sha) && tagObjects.length < MAX_TAG_DEPTH) {
      if (stop()) return null;
      if (!budget()) break;
      seen.add(next.sha);
      requests++;
      try {
        const o = await client.getTagObject(repo, next.sha);
        tagObjects.push(o);
        next = isRecord(o) && isRecord(o.object) ? o.object : null;
      } catch (error) {
        // The ref exists, so a missing tag object is a failure too, never "no such tag".
        failed.push({ tag, why: `annotated tag object: ${why(error)}` });
        return { state: "failed", why: `annotated tag object: ${why(error)}` };
      }
    }
    return { state: "loaded", ref, tagObjects };
  }

  const results = new Map<string, TagLookup>();
  let next = 0;
  const worker = async () => {
    while (next < tags.length) {
      if (stop() || !budget()) return;
      const tag = tags[next++]!;
      const result = await lookup(tag);
      if (result) results.set(tag, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, tags.length) }, worker));
  stop();
  for (const x of waiting) {
    const result = results.get(x.v.tag_name);
    if (result) out[x.i]!.tag = result;
  }
  return { releases: out, failed, requests, cancelled };
}

function result(releases: LoadedReleases["releases"], batch: Awaited<ReturnType<typeof resolveBatch>>, previous: Pick<LoadedReleases, "failed" | "totalRequests">, pages: number, moreReleases: boolean): LoadedReleases {
  return {
    releases: batch.releases,
    pages,
    moreReleases,
    unresolved: batch.releases.filter((r) => toRelease(r.release) && r.tag.state === "not loaded").length,
    failed: [...previous.failed, ...batch.failed],
    requests: batch.requests,
    totalRequests: previous.totalRequests + batch.requests,
    cancelled: batch.cancelled,
  };
}

export async function loadReleases(client: Client, repo: RepoRef, run: Pick<Run, "head_sha">, signal?: AbortSignal, limits = RELEASE_LIMITS): Promise<LoadedReleases> {
  const listed = await listPage(client, repo, 1);
  const releases = append([], listed.items);
  const batch = await resolveBatch(client, repo, run, releases, signal, limits);
  return result(releases, batch, { failed: [], totalRequests: 0 }, 1, listed.hasNext);
}

/** Whether `loadMoreReleases` has anything left to do. */
export const hasMoreReleases = (loaded: LoadedReleases) => loaded.unresolved > 0 || loaded.moreReleases;

/**
 * The next batch: releases not looked up yet, or, when every loaded release has been looked up, the next listing page.
 * `previous` is never changed; on cancellation the result is marked `cancelled` and must be dropped.
 */
export async function loadMoreReleases(client: Client, repo: RepoRef, run: Pick<Run, "head_sha">, previous: LoadedReleases, signal?: AbortSignal, limits = RELEASE_LIMITS): Promise<LoadedReleases> {
  let releases = previous.releases;
  let pages = previous.pages;
  let moreReleases = previous.moreReleases;
  if (previous.unresolved === 0 && previous.moreReleases) {
    const listed = await listPage(client, repo, pages + 1);
    pages++;
    moreReleases = listed.hasNext;
    releases = append(releases, listed.items);
  }
  const batch = await resolveBatch(client, repo, run, releases, signal, limits);
  return result(releases, batch, previous, pages, moreReleases);
}
