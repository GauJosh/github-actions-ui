// The emergency runner's events: one per line of its stdout, prefixed with EVENT_PREFIX and authenticated with the
// execution's key (event-stream.ts reads and verifies them). The runner masks secret values and sanitizes workflow
// text before emitting, so events never carry them. `summarize` folds events into the view the executor
// returns and the UI shows. Pure.

export const EVENT_PREFIX = "::gha-emergency::";
/** The runner's first log line: its public key for this execution (security review H2, event-stream.ts). */
export const KEY_PREFIX = "::gha-emergency-key::";
/** Result lines of the network canary (deploy/emergency/runner/canary.ts, read by network-check.ts). */
export const CANARY_PREFIX = "::gha-emergency-canary::";

export type StepResult = "success" | "failure" | "skipped" | "cancelled";

export type RunnerEvent =
  | { type: "execution-start"; at: string; executionId: string; digest: string; workflow: string; source: { repository: string; sha: string } }
  | { type: "verify"; at: string; ok: boolean; files: number; problems: string[] }
  | { type: "network"; at: string; host: string; reachable: boolean; detail: string }
  | { type: "job-start"; at: string; job: string; name: string; workflow: string; needs: string[] }
  | { type: "job-end"; at: string; job: string; result: StepResult; outputs: Record<string, string>; reason?: string }
  | { type: "step-start"; at: string; job: string; step: number; name: string; kind: string; detail?: string }
  | { type: "step-end"; at: string; job: string; step: number; outcome: StepResult; conclusion: StepResult; exitCode: number | null; durationMs: number; outputs: Record<string, string>; reason?: string }
  | { type: "log"; at: string; job?: string; step?: number; stream: "stdout" | "stderr" | "runner"; text: string }
  /** Reported by workflow code (::error:: and the like): the workflow's claim, not the runner's finding. */
  | { type: "annotation"; at: string; job?: string; step?: number; level: "error" | "warning" | "notice"; message: string; source?: "workflow" | "runner" }
  | { type: "execution-end"; at: string; result: StepResult; durationMs: number; outputs: Record<string, string>; reason?: string };

export type StepView = { step: number; name: string; kind: string; detail?: string; status: "running" | StepResult; exitCode: number | null; durationMs?: number; outputs: Record<string, string>; reason?: string; logs: number[] };
export type JobView = { job: string; name: string; workflow: string; needs: string[]; status: "running" | StepResult; outputs: Record<string, string>; reason?: string; steps: StepView[]; order: number };
export type ExecutionView = {
  status: "pending" | "running" | StepResult | "error";
  digest?: string;
  workflow?: string;
  source?: { repository: string; sha: string };
  verified?: { ok: boolean; files: number; problems: string[] };
  network: { host: string; reachable: boolean; detail: string }[];
  jobs: JobView[];
  /** Log lines; steps refer to them by index. */
  logs: { stream: string; text: string; job?: string; step?: number }[];
  annotations: { level: string; message: string; job?: string; step?: number; source?: string }[];
  /** The executor's check of the runner's event stream (security review H3). */
  stream?: { ok: boolean; events: number; complete: boolean; legacy?: boolean; problem?: string };
  /** The runner container's exit code, from Kubernetes. */
  exitCode?: number;
  outputs: Record<string, string>;
  durationMs?: number;
  reason?: string;
};

export function summarize(events: RunnerEvent[]): ExecutionView {
  const v: ExecutionView = { status: "pending", network: [], jobs: [], logs: [], annotations: [], outputs: {} };
  const job = (key: string) => v.jobs.find((j) => j.job === key);
  for (const e of events) {
    switch (e.type) {
      case "execution-start":
        v.status = "running";
        v.digest = e.digest;
        v.workflow = e.workflow;
        v.source = e.source;
        break;
      case "verify":
        v.verified = { ok: e.ok, files: e.files, problems: e.problems };
        break;
      case "network":
        v.network.push({ host: e.host, reachable: e.reachable, detail: e.detail });
        break;
      case "job-start":
        v.jobs.push({ job: e.job, name: e.name, workflow: e.workflow, needs: e.needs, status: "running", outputs: {}, steps: [], order: v.jobs.length });
        break;
      case "job-end": {
        const j = job(e.job) ?? (v.jobs.push({ job: e.job, name: e.job, workflow: "", needs: [], status: "running", outputs: {}, steps: [], order: v.jobs.length }), job(e.job)!);
        j.status = e.result;
        j.outputs = e.outputs;
        j.reason = e.reason;
        break;
      }
      case "step-start":
        job(e.job)?.steps.push({ step: e.step, name: e.name, kind: e.kind, detail: e.detail, status: "running", exitCode: null, outputs: {}, logs: [] });
        break;
      case "step-end": {
        const s = job(e.job)?.steps.find((x) => x.step === e.step);
        if (s) Object.assign(s, { status: e.conclusion, exitCode: e.exitCode, durationMs: e.durationMs, outputs: e.outputs, reason: e.reason });
        break;
      }
      case "log": {
        v.logs.push({ stream: e.stream, text: e.text, job: e.job, step: e.step });
        if (e.job !== undefined && e.step !== undefined) job(e.job)?.steps.find((x) => x.step === e.step)?.logs.push(v.logs.length - 1);
        break;
      }
      case "annotation":
        v.annotations.push({ level: e.level, message: e.message, job: e.job, step: e.step, source: e.source });
        break;
      case "execution-end":
        v.status = e.result;
        v.durationMs = e.durationMs;
        v.outputs = e.outputs;
        v.reason = e.reason;
        break;
    }
  }
  return v;
}
