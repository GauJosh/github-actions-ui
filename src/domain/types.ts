// Shared domain types. Pure: no imports from ui, github, logs or browser APIs.

export type RunRef = { owner: string; repo: string; runId: number };
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
};

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
