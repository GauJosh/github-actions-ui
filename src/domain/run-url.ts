import type { RepoRef, RunFilters, RunRef } from "./types";

const NAME = "[A-Za-z0-9_.-]+";
const RUN_URL = new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/actions/runs/(\\d+)(?:/job/(\\d+))?(?:/attempts/(\\d+))?/?(?:[?#].*)?$`);

/** Parses a GitHub Actions run (or job, or run attempt) URL. Returns null for anything else. */
export function parseRunUrl(input: string): (RunRef & { jobId?: number; attempt?: number }) | null {
  const m = RUN_URL.exec(input.trim());
  if (!m) return null;
  const ref: RunRef & { jobId?: number; attempt?: number } = { owner: m[1]!, repo: m[2]!, runId: Number(m[3]) };
  if (m[4]) ref.jobId = Number(m[4]);
  if (m[5] && Number(m[5]) > 0) ref.attempt = Number(m[5]);
  return ref;
}

const REPO = new RegExp(`^(${NAME})/(${NAME})$`);

/** Parses "owner/repo" or a github.com repository URL. */
export function parseRepo(input: string): RepoRef | null {
  const text = input
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const m = REPO.exec(text);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/**
 * In-app location, kept in the URL fragment. It never contains credentials.
 * - `#/` repositories
 * - `#/repos/OWNER/REPO?status=…&branch=…&event=…&workflow=…` the run list
 * - `#/runs/OWNER/REPO/RUN[/phases/PHASE[/calls/JOB]][/jobs/JOB[/steps/STEP][/log | /L<line>]][?view=graph|timeline|source|compare|search|history][&attempt=N][&impact=all|NODE][&base=RUN.N][&q=TEXT]`
 *   a run: its selected phase, an opened reusable-workflow call, a selected job, its log opened at a step or a
 *   line, the view, the run attempt (absent: the latest attempt), the failure impact shown on the graph, the
 *   baseline of a comparison (a run and an explicit attempt), and the search text
 */
export type Route = {
  repo?: RepoRef;
  filters?: RunFilters;
  run?: RunRef;
  phase?: string;
  call?: string;
  jobId?: number;
  /** A step number: the log opens at that step's output. Implies `log`. */
  step?: number;
  log?: boolean;
  line?: number;
  view?: RunView;
  /** A run attempt (1-based). Absent: the run's latest attempt. */
  attempt?: number;
  /** Failure impact on the execution graph: every failure ("all"), or one failure's graph node key. */
  impact?: string;
  /** The baseline of a comparison: always an explicit run and attempt, so the comparison never shifts. */
  base?: { runId: number; attempt: number };
  /** Search text (the search view), also highlighted in a log opened from a result. */
  q?: string;
};

/** A run's views besides the default release overview. */
export type RunView = "graph" | "timeline" | "source" | "compare" | "search" | "history";
const VIEWS: RunView[] = ["graph", "timeline", "source", "compare", "search", "history"];

export function routeToHash(route: Route): string {
  if (route.run) {
    const { owner, repo, runId } = route.run;
    let hash = `#/runs/${owner}/${repo}/${runId}`;
    if (route.phase) {
      hash += `/phases/${encodeURIComponent(route.phase)}`;
      if (route.call) hash += `/calls/${encodeURIComponent(route.call)}`;
    }
    if (route.jobId !== undefined) {
      hash += `/jobs/${route.jobId}`;
      if (route.step !== undefined) hash += `/steps/${route.step}`;
      if (route.line !== undefined) hash += `/L${route.line}`;
      else if (route.log && route.step === undefined) hash += "/log";
    }
    const query = [
      route.view && `view=${route.view}`,
      route.attempt && `attempt=${route.attempt}`,
      route.impact && `impact=${encodeURIComponent(route.impact)}`,
      route.base && `base=${route.base.runId}.${route.base.attempt}`,
      route.q && `q=${encodeURIComponent(route.q)}`,
    ]
      .filter(Boolean)
      .join("&");
    return query ? `${hash}?${query}` : hash;
  }
  if (route.repo) {
    const query = new URLSearchParams();
    const f = route.filters ?? {};
    if (f.status) query.set("status", f.status);
    if (f.workflowId) query.set("workflow", String(f.workflowId));
    if (f.branch) query.set("branch", f.branch);
    if (f.event) query.set("event", f.event);
    const q = query.toString();
    return `#/repos/${route.repo.owner}/${route.repo.repo}${q ? `?${q}` : ""}`;
  }
  return "#/";
}

const SEGMENT = "[A-Za-z0-9_.%:-]+";
const RUN_HASH = new RegExp(
  `^#/runs/(${NAME})/(${NAME})/(\\d+)(?:/phases/(${SEGMENT})(?:/calls/(${SEGMENT}))?)?(?:/jobs/(\\d+)(?:/steps/(\\d+))?(?:/(log)|/L(\\d+))?)?(?:\\?(.*))?$`,
);
const REPO_HASH = new RegExp(`^#/repos/(${NAME})/(${NAME})(?:\\?(.*))?$`);

export function parseHash(hash: string): Route {
  let m = RUN_HASH.exec(hash);
  if (m) {
    const route: Route = { run: { owner: m[1]!, repo: m[2]!, runId: Number(m[3]) } };
    if (m[4]) route.phase = decodeURIComponent(m[4]);
    if (m[5]) route.call = decodeURIComponent(m[5]);
    if (m[6]) route.jobId = Number(m[6]);
    if (m[7]) {
      route.step = Number(m[7]);
      route.log = true;
    }
    if (m[8]) route.log = true;
    if (m[9]) {
      route.line = Number(m[9]);
      route.log = true;
    }
    const q = new URLSearchParams(m[10] ?? "");
    const view = q.get("view");
    if (VIEWS.includes(view as RunView)) route.view = view as RunView;
    const attempt = Number(q.get("attempt"));
    if (Number.isInteger(attempt) && attempt > 0) route.attempt = attempt;
    const impact = q.get("impact");
    if (impact) route.impact = impact;
    const base = /^(\d+)\.(\d+)$/.exec(q.get("base") ?? "");
    if (base && Number(base[2]) > 0) route.base = { runId: Number(base[1]), attempt: Number(base[2]) };
    const text = q.get("q");
    if (text) route.q = text;
    return route;
  }
  m = REPO_HASH.exec(hash);
  if (m) {
    const q = new URLSearchParams(m[3] ?? "");
    const filters: RunFilters = {};
    if (q.get("status")) filters.status = q.get("status")!;
    if (q.get("branch")) filters.branch = q.get("branch")!;
    if (q.get("event")) filters.event = q.get("event")!;
    const workflow = Number(q.get("workflow"));
    if (Number.isInteger(workflow) && workflow > 0) filters.workflowId = workflow;
    return { repo: { owner: m[1]!, repo: m[2]! }, filters };
  }
  return {};
}
