import { redact } from "../auth/redact";
import type { ApiFailure, Job, JobRef, RepoRef, Repository, Run, RunFilters, RunRef, Workflow } from "../domain/types";
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

  const repoPath = (ref: RepoRef) => `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;

  return {
    apiHost,

    /** Repositories the token can see, most recently pushed first. Fine-grained tokens list only their selected repositories. */
    async listRepos(page: number): Promise<{ repos: Repository[]; hasNext: boolean }> {
      const { body, link } = await getJson<Repository[]>(`/user/repos?per_page=100&sort=pushed&page=${page}`);
      return { repos: body, hasNext: nextPath(link, apiBase) !== null };
    },

    async listWorkflows(ref: RepoRef): Promise<Workflow[]> {
      return (await getJson<{ workflows: Workflow[] }>(`${repoPath(ref)}/actions/workflows?per_page=100`)).body.workflows;
    },

    /** One page of recent runs (no jobs or logs). Filters map to GitHub's own query parameters. */
    async listRuns(ref: RepoRef, filters: RunFilters, page: number, perPage = 25): Promise<{ runs: Run[]; totalCount: number; hasNext: boolean }> {
      const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      if (filters.status) query.set("status", filters.status);
      if (filters.branch) query.set("branch", filters.branch);
      if (filters.event) query.set("event", filters.event);
      const base = filters.workflowId ? `${repoPath(ref)}/actions/workflows/${filters.workflowId}/runs` : `${repoPath(ref)}/actions/runs`;
      const { body, link } = await getJson<{ total_count: number; workflow_runs: Run[] }>(`${base}?${query}`);
      return { runs: body.workflow_runs, totalCount: body.total_count, hasNext: nextPath(link, apiBase) !== null };
    },

    /** Review history of a run's deployment approvals (read-only). */
    async getApprovals(ref: RunRef): Promise<unknown[]> {
      return (await getJson<unknown[]>(`${repoPath(ref)}/actions/runs/${ref.runId}/approvals`)).body;
    },

    /** Deployments of a run that are waiting for approval (read-only). */
    async getPendingDeployments(ref: RunRef): Promise<unknown[]> {
      return (await getJson<unknown[]>(`${repoPath(ref)}/actions/runs/${ref.runId}/pending_deployments`)).body;
    },

    /** A file at an exact commit (Contents API). Returns its text. */
    async getWorkflowFile(ref: RepoRef, path: string, commit: string): Promise<string> {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const { body } = await getJson<{ type?: string; encoding?: string; content?: string }>(
        `${repoPath(ref)}/contents/${encoded}?ref=${encodeURIComponent(commit)}`,
      );
      if (body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
        throw new GitHubError({ kind: "http-error", status: 422 });
      }
      const binary = atob(body.content.replace(/\s/g, ""));
      return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    },

    /** The run (its latest attempt), or one attempt of it (`GET …/runs/{id}/attempts/{n}`). */
    async getRun(ref: RunRef, attempt?: number): Promise<Run> {
      return (await getJson<Run>(`${repoPath(ref)}/actions/runs/${ref.runId}${attempt ? `/attempts/${attempt}` : ""}`)).body;
    },

    /**
     * Jobs of the latest attempt (`filter=latest`), or of one attempt (`…/attempts/{n}/jobs`), following
     * `Link: rel="next"` within the API host.
     */
    async getJobs(ref: RunRef, attempt?: number): Promise<Job[]> {
      const jobs: Job[] = [];
      let path: string | null = attempt
        ? `${repoPath(ref)}/actions/runs/${ref.runId}/attempts/${attempt}/jobs?per_page=100`
        : `${repoPath(ref)}/actions/runs/${ref.runId}/jobs?filter=latest&per_page=100`;
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
