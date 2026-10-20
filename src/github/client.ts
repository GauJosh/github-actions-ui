import { redact } from "../auth/redact";
import type { ApiFailure, Job, JobRef, Run, RunRef } from "../domain/types";
import type { ReadMethod, Transport, TransportResponse } from "./transport";

export class GitHubError extends Error {
  readonly failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(`GitHub request failed: ${failure.kind}`);
    this.failure = failure;
  }
}

/** Maps a non-success response to an explicit failure. `finalHost` distinguishes the API from the log host. */
export async function classifyFailure(r: TransportResponse, apiHost: string): Promise<ApiFailure> {
  const { response, finalHost } = r;
  const status = response.status;
  if (status === 401) return { kind: "auth-failed" };
  if (status === 410) return { kind: "expired" };
  if (status === 404) return { kind: "not-found-or-no-permission" };
  if (status === 403 && finalHost !== apiHost) return { kind: "signed-url-rejected" };
  if (status === 403 || status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (status === 429 || remaining === "0" || response.headers.has("retry-after")) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      return Number.isFinite(reset) && reset > 0 ? { kind: "rate-limited", resetAt: reset * 1000 } : { kind: "rate-limited" };
    }
    let detail = "Permission denied";
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = redact(body.message).slice(0, 200);
    } catch {
      // keep the generic detail
    }
    return { kind: "permission", detail };
  }
  return { kind: "http-error", status };
}

const JSON_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export type GitHubClient = ReturnType<typeof createGitHubClient>;

export function createGitHubClient(options: { apiBase: string; transport: Transport }) {
  const { apiBase, transport } = options;
  const apiHost = new URL(apiBase).host;

  async function call(method: ReadMethod, path: string, headers?: Record<string, string>, signal?: AbortSignal) {
    try {
      return await transport({ method, url: apiBase + path, headers, signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      if (error instanceof TypeError) throw new GitHubError({ kind: "network" });
      throw error;
    }
  }

  async function getJson<T>(path: string): Promise<{ body: T; link: string | null }> {
    const r = await call("GET", path, JSON_HEADERS);
    if (!r.response.ok) throw new GitHubError(await classifyFailure(r, apiHost));
    return { body: (await r.response.json()) as T, link: r.response.headers.get("link") };
  }

  const repoPath = (ref: RunRef) => `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;

  return {
    apiHost,

    async getRun(ref: RunRef): Promise<Run> {
      return (await getJson<Run>(`${repoPath(ref)}/actions/runs/${ref.runId}`)).body;
    },

    /** Jobs of the latest attempt, following `Link: rel="next"` within the API host. */
    async getJobs(ref: RunRef): Promise<Job[]> {
      const jobs: Job[] = [];
      let path: string | null = `${repoPath(ref)}/actions/runs/${ref.runId}/jobs?filter=latest&per_page=100`;
      for (let page = 0; path && page < 10; page++) {
        const { body, link } = (await getJson<{ jobs: Job[] }>(path)) as { body: { jobs: Job[] }; link: string | null };
        jobs.push(...body.jobs);
        path = nextPath(link, apiBase);
      }
      return jobs;
    },

    /** A job-log request. Ranges always use the explicit `bytes=a-b` form; the log host ignores suffix ranges. */
    requestJobLog(ref: JobRef, method: ReadMethod, range?: [number, number], signal?: AbortSignal) {
      const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined;
      return call(method, `${repoPath(ref)}/actions/jobs/${ref.jobId}/logs`, headers, signal);
    },
  };
}

function nextPath(link: string | null, apiBase: string): string | null {
  const next = link?.split(",").find((part) => /rel="next"/.test(part));
  const url = next?.match(/<([^>]+)>/)?.[1];
  if (!url || !url.startsWith(apiBase + "/")) return null;
  return url.slice(apiBase.length);
}
