// Shared domain types. Pure: no imports from ui, github, logs or browser APIs.

export type RepoRef = { owner: string; repo: string };
export type RunRef = RepoRef & { runId: number };
export type JobRef = RunRef & { jobId: number };

export type Step = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type Job = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  run_attempt?: number;
  created_at?: string | null;
  runner_name?: string | null;
  labels?: string[];
  steps?: Step[];
};

export type Run = {
  id: number;
  name: string | null;
  display_title: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  event: string;
  path?: string;
  run_number?: number;
  workflow_id?: number;
  created_at?: string;
  run_started_at?: string | null;
  updated_at?: string;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
  head_commit?: { id: string; message: string } | null;
  pull_requests?: { number: number }[];
  /** Reusable workflows the run called, resolved by GitHub to a commit. */
  referenced_workflows?: { path: string; sha: string; ref?: string }[];
};

export type Repository = {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description?: string | null;
  pushed_at?: string | null;
};

export type Workflow = { id: number; name: string; path: string; state: string };

export type RunFilters = { status?: string; branch?: string; event?: string; workflowId?: number };

/** Failures from the GitHub API or the log host, mapped to explicit states (docs/ARCHITECTURE.md §5.1, §6.3). */
export type ApiFailure =
  | { kind: "auth-failed" }
  | { kind: "rate-limited"; resetAt?: number }
  | { kind: "permission"; detail: string }
  | { kind: "not-found-or-no-permission" }
  | { kind: "expired" }
  | { kind: "signed-url-rejected" }
  | { kind: "http-error"; status: number }
  | { kind: "network" };

const NOT_SUCCESSFUL = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

/** A completed job or step that did not succeed. The reason is not classified here (that is R3, milestone M3). */
export function isNotSuccessful(item: { status: string; conclusion: string | null }): boolean {
  return item.status === "completed" && item.conclusion !== null && NOT_SUCCESSFUL.has(item.conclusion);
}
