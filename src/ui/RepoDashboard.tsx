// Repository run list. Lightweight: one request per page of runs (no jobs or logs), plus the workflow
// list for the filter. Filters live in the URL fragment so they survive refresh and back/forward.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Environment } from "../app/environment";
import { durationMs } from "../domain/graph/build";
import { routeToHash } from "../domain/run-url";
import type { RepoRef, Run, RunFilters } from "../domain/types";
import { AttemptMismatchError, GitHubError } from "../github/client";
import { failureText } from "./copy";
import { absoluteTime, firstLine, formatDuration, relativeTime, shortSha } from "./format";
import { StatusBadge, statusOf } from "./status";

const PER_PAGE = 25;
const STATUS_OPTIONS: [string, string][] = [
  ["", "Any status"],
  ["failure", "Failed"],
  ["success", "Succeeded"],
  ["cancelled", "Cancelled"],
  ["timed_out", "Timed out"],
  ["in_progress", "Running"],
  ["queued", "Queued"],
  ["waiting", "Waiting"],
  ["action_required", "Action required"],
];
const EVENT_OPTIONS = ["push", "pull_request", "pull_request_target", "workflow_dispatch", "schedule", "release", "workflow_run", "merge_group", "workflow_call"];

export function RepoDashboard({ env, repo, filters }: { env: Environment; repo: RepoRef; filters: RunFilters }) {
  const setFilters = (next: RunFilters) => {
    window.location.hash = routeToHash({ repo, filters: next });
  };
  const runs = useInfiniteQuery({
    queryKey: ["runs", env.mode, repo.owner, repo.repo, filters],
    queryFn: ({ pageParam }) => env.client.listRuns(repo, filters, pageParam, PER_PAGE),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasNext ? all.length + 1 : undefined),
  });
  const workflows = useQuery({ queryKey: ["workflows", env.mode, repo.owner, repo.repo], queryFn: () => env.client.listWorkflows(repo) });
  const list = runs.data?.pages.flatMap((p) => p.runs) ?? [];
  const total = runs.data?.pages[0]?.totalCount;
  const filtered = Boolean(filters.status || filters.branch || filters.event || filters.workflowId);
  const workflowNames = new Map((workflows.data ?? []).map((w) => [w.id, w.name]));

  return (
    <div className="dashboard">
      <header className="page-head">
        <div>
          <p className="eyebrow">Repository</p>
          <h2>
            {repo.owner}/{repo.repo}
          </h2>
        </div>
        <div className="head-actions">
          <a href={`https://github.com/${repo.owner}/${repo.repo}/actions`} target="_blank" rel="noreferrer noopener">
            Actions on GitHub
          </a>
          <button onClick={() => void runs.refetch()} disabled={runs.isFetching}>
            {runs.isFetching && !runs.isFetchingNextPage ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <Filters filters={filters} onChange={setFilters} workflows={workflows.data} workflowsUnavailable={workflows.isError} />

      <section className="panel runs-panel" aria-labelledby="runs-heading" aria-busy={runs.isFetching}>
        <h3 id="runs-heading" className="visually-hidden">
          Workflow runs
        </h3>
        {runs.isPending && <RunSkeleton />}
        {runs.isError && !runs.data && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />}
        {runs.data && list.length === 0 && (
          <p className="state empty" data-testid="runs-empty">
            {filtered ? "No runs match these filters." : "This repository has no workflow runs that GitHub still retains."}
            {filtered && (
              <>
                {" "}
                <button className="linklike" onClick={() => setFilters({})}>
                  Clear filters
                </button>
              </>
            )}
          </p>
        )}
        {list.length > 0 && (
          <>
            <p className="note" data-testid="runs-count">
              Showing {list.length} of {total ?? "?"} runs{filtered ? " matching the filters" : ""}.
            </p>
            <ol className="runs" data-testid="run-list">
              {list.map((run) => (
                <RunRow key={run.id} repo={repo} run={run} workflowName={workflowNames.get(run.workflow_id ?? -1)} />
              ))}
            </ol>
          </>
        )}
        {runs.isFetchNextPageError && (
          <div className="state state-error" role="alert">
            Showing partial results: the next page could not be loaded. {runs.error instanceof GitHubError ? failureText(runs.error.failure) : ""}{" "}
            <button onClick={() => void runs.fetchNextPage()}>Try again</button>
          </div>
        )}
        {runs.isRefetchError && runs.data && (
          <p className="state state-error" role="alert">
            Refresh failed; showing the previous results. {runs.error instanceof GitHubError ? failureText(runs.error.failure) : ""}
          </p>
        )}
        {runs.hasNextPage && !runs.isFetchNextPageError && (
          <button className="load-more" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
            {runs.isFetchingNextPage ? "Loading…" : `Load ${PER_PAGE} more`}
          </button>
        )}
      </section>
    </div>
  );
}

function Filters({
  filters,
  onChange,
  workflows,
  workflowsUnavailable,
}: {
  filters: RunFilters;
  onChange(f: RunFilters): void;
  workflows?: { id: number; name: string; path: string }[];
  workflowsUnavailable: boolean;
}) {
  const [branch, setBranch] = useState(filters.branch ?? "");
  return (
    <form
      className="filters"
      aria-label="Run filters"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ ...filters, branch: branch.trim() || undefined });
      }}
    >
      <div className="field">
        <label htmlFor="filter-status">Status</label>
        <select id="filter-status" value={filters.status ?? ""} onChange={(e) => onChange({ ...filters, status: e.target.value || undefined })}>
          {STATUS_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="filter-workflow">Workflow</label>
        <select
          id="filter-workflow"
          value={filters.workflowId ?? ""}
          disabled={workflowsUnavailable}
          title={workflowsUnavailable ? "The workflow list could not be loaded" : undefined}
          onChange={(e) => onChange({ ...filters, workflowId: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">{workflowsUnavailable ? "Workflows unavailable" : "Any workflow"}</option>
          {workflows?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="filter-event">Event</label>
        <select id="filter-event" value={filters.event ?? ""} onChange={(e) => onChange({ ...filters, event: e.target.value || undefined })}>
          <option value="">Any event</option>
          {EVENT_OPTIONS.map((ev) => (
            <option key={ev} value={ev}>
              {ev}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="filter-branch">Branch</label>
        <input id="filter-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="any branch" onBlur={() => branch.trim() !== (filters.branch ?? "") && onChange({ ...filters, branch: branch.trim() || undefined })} />
      </div>
      <button type="submit" className="visually-hidden">
        Apply filters
      </button>
    </form>
  );
}

function RunRow({ repo, run, workflowName }: { repo: RepoRef; run: Run; workflowName?: string }) {
  const status = statusOf(run);
  const started = run.run_started_at ?? run.created_at;
  const approx = run.status === "completed" ? durationMs(run.run_started_at, run.updated_at) : undefined;
  const commit = firstLine(run.head_commit?.message);
  return (
    <li>
      <a className={`run-row s-${status}`} href={routeToHash({ run: { ...repo, runId: run.id } })} data-run-id={run.id}>
        <StatusBadge status={status} />
        <span className="run-main">
          <span className="run-title">{run.display_title}</span>
          <span className="run-sub">
            <span className="run-workflow">{workflowName ?? run.path?.split("/").at(-1) ?? run.name}</span>
            {run.run_number !== undefined && <span>#{run.run_number}</span>}
            {run.run_attempt > 1 && <span>attempt {run.run_attempt}</span>}
            <span className="chip">{run.event}</span>
            {run.pull_requests?.map((pr) => (
              <span key={pr.number} className="chip">
                PR #{pr.number}
              </span>
            ))}
            {run.head_branch && <span className="chip branch">{run.head_branch}</span>}
            <span className="mono">{shortSha(run.head_sha)}</span>
            {commit && commit !== run.display_title && <span className="commit">{commit}</span>}
          </span>
        </span>
        <span className="run-meta">
          {run.actor && <span>{run.actor.login}</span>}
          {started && <time title={absoluteTime(started)}>{relativeTime(started)}</time>}
          {approx !== undefined && <span title="From run start to the run's last update (the run list has no completion time)">≈ {formatDuration(approx)}</span>}
          {run.status !== "completed" && <span>{run.status.replace("_", " ")}</span>}
        </span>
      </a>
    </li>
  );
}

function RunSkeleton() {
  return (
    <ol className="runs skeleton" aria-label="Loading runs">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="run-row skeleton-row" />
      ))}
    </ol>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p>{error instanceof GitHubError ? failureText(error.failure) : error instanceof AttemptMismatchError ? error.message : "Something went wrong talking to GitHub."}</p>
      {onRetry && <button onClick={onRetry}>Try again</button>}
    </div>
  );
}
