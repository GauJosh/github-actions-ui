// Artifacts of one workflow run, for the artifact evidence model (domain/insights/artifacts.ts). Read-only (GET):
// metadata from the run-scoped listing only; `archive_download_url` is never requested.
//
// Pages of 100 are read one after another, at most `pages` per action. GitHub's `total_count` (from the last page
// read) tells a complete listing from a truncated one. Items are kept once per numeric id, in case the listing shifts
// between pages; items without a numeric id are kept as returned so the model counts them as malformed.
//
// Failures keep the client's classification (a 404 stays "not found or no permission": a deleted run, a missing or
// private repository, or a token without access look the same) and fail the whole action, so a partial listing is
// never shown as the run's artifacts. The abort signal is checked before each page and after the last one; a
// cancelled action returns `cancelled: true` and must not be shown.
import type { ArtifactListing } from "../domain/insights/artifacts";
import type { RunRef } from "../domain/types";
import type { GitHubClient } from "../github/client";

export const ARTIFACT_LIMITS = { pages: 3 };

export type LoadedArtifacts = ArtifactListing & {
  /** Listing pages read. */
  pages: number;
  /** Stopped by the abort signal; the result is partial and must not be shown. */
  cancelled: boolean;
};

type Client = Pick<GitHubClient, "listRunArtifacts">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class MalformedArtifactListing extends Error {
  constructor(page: number) {
    super(`GitHub's artifact listing (page ${page}) was not in the documented shape.`);
  }
}

export async function loadArtifacts(client: Client, ref: RunRef, signal?: AbortSignal, limits = ARTIFACT_LIMITS): Promise<LoadedArtifacts> {
  const items: unknown[] = [];
  const ids = new Set<number>();
  let totalCount = 0;
  let morePages = false;
  let pages = 0;
  const result = (cancelled: boolean): LoadedArtifacts => ({ items, totalCount, morePages, pages, cancelled });

  for (let page = 1; page <= limits.pages; page++) {
    if (signal?.aborted) return result(true);
    const { body, hasNext } = await client.listRunArtifacts(ref, page);
    if (!isRecord(body) || !Array.isArray(body.artifacts) || typeof body.total_count !== "number" || !Number.isInteger(body.total_count) || body.total_count < 0) {
      throw new MalformedArtifactListing(page);
    }
    pages = page;
    totalCount = body.total_count;
    morePages = hasNext;
    for (const raw of body.artifacts as unknown[]) {
      const id = isRecord(raw) && typeof raw.id === "number" ? raw.id : undefined;
      if (id !== undefined && ids.has(id)) continue;
      if (id !== undefined) ids.add(id);
      items.push(raw);
    }
    if (!hasNext) break;
  }
  return result(signal?.aborted === true);
}
