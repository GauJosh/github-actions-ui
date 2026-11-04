// The emergency runner: executes one workflow from a verified snapshot, inside the Kubernetes Job's container, with
// no access to GitHub. It reproduces a documented subset of GitHub Actions (docs/EMERGENCY_EXECUTION.md) and never
// skips a step silently: anything it can't run fails the step with a reason.
//
// - Every job gets a fresh copy of the packaged workspace (GitHub runs each job on a fresh runner).
// - Jobs run one at a time, in `needs:` order (file order among ready jobs); reusable workflows run inline.
// - Steps: `run:` (bash, sh, python), JavaScript actions (main, and post at job end), composite actions,
//   and actions/checkout of the snapshot commit (already satisfied by the packaged workspace).
// - Outputs, exported env, PATH additions and the step summary come from the $GITHUB_OUTPUT, $GITHUB_ENV,
//   $GITHUB_PATH, $GITHUB_STATE and $GITHUB_STEP_SUMMARY files. Of the stdout workflow commands, ::add-mask::,
//   ::error::, ::warning:: and ::notice:: are honoured; ::set-output:: and ::save-state:: are deprecated by GitHub
//   and ignored as untrusted data (security review M1), with a runner warning.
// - Secret values (and ::add-mask:: values), and their standard and URL-safe Base64 encodings, are masked in every
//   log line, annotation and output before they are emitted (security review M2). Masking is best-effort: it can't
//   catch a secret that was hashed, encrypted, reversed or split across newlines.
// - Security review M1: a ${{ }} value in a run: script is passed as an environment variable and referenced as data
//   (src/emergency/script-substitution.ts), never pasted into the script text, so it cannot become shell or Python
//   syntax.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { evaluate, interpolate, interpolateString, parseCondition, stringify, truthy, type JobStatus } from "../../../src/emergency/expressions.ts";
import { substituteRunWithContext, UnsafeExpressionContextError } from "../../../src/emergency/script-substitution.ts";
import { sanitizeText } from "../../../src/emergency/event-stream.ts";
import type { RunnerEvent, StepResult } from "../../../src/emergency/events.ts";
import type { ActionDef, JobDef, StepDef, WorkflowDef } from "../../../src/emergency/model.ts";
import { isCheckout, normalizePath, parseAction, parseUses, parseWorkflow } from "../../../src/emergency/model.ts";
import type { ActionEntry, FileEntry, Manifest } from "../../../src/emergency/snapshot.ts";
import { revalidateSnapshot } from "../../../src/emergency/revalidate.ts";
import { hasErrors, manifestDigest, verifySnapshot, WORKSPACE } from "../../../src/emergency/snapshot.ts";

export type RunnerConfig = {
  snapshotDir: string;
  workDir: string;
  /** Kubernetes Secret volume: one file per secret, named after it. Absent when the snapshot needs no secrets. */
  secretsDir?: string;
  execution: { id: string; workflow: string; digest: string; inputs: Record<string, string>; variables: Record<string, string> };
  emit: (event: RunnerEvent) => void;
  /** Executables; defaults suit the runner image. */
  commands?: { bash: string; sh: string; python: string; node: string };
  /** Upper bound for any job or step timeout, in minutes. */
  maxMinutes?: number;
  /** Security review M6: characters of workflow log output forwarded per step. Default 1 MiB. */
  maxStepLogBytes?: number;
  /** Security review M6: characters of workflow log output forwarded for the whole execution. Default 4 MiB. */
  maxLogBytes?: number;
  /** Hosts checked (and expected to be unreachable) before execution. Empty: no check. */
  networkProbe?: string[];
  basePath?: string;
};

type Contexts = Record<string, unknown>;
type JobRecord = { result: StepResult; outputs: Record<string, string> };

/**
 * Redacts secret values (and ::add-mask:: values) from everything the runner emits (security review M2). Besides the
 * exact value, it registers the value's common deterministic encodings, because a workflow can trivially re-encode a
 * secret to dodge exact-match masking: standard and URL-safe Base64, each with and without padding. Masking is
 * best-effort and line-oriented: it cannot catch a secret that was hashed, encrypted, reversed, split across newlines,
 * or otherwise transformed. The real protections are not packaging secret values (C1/H1) and restricting log access.
 */
// Security review F1/M6: bounds on what workflow ::add-mask:: can register. Without them a flood of mask commands
// grows the runner's memory and makes masking (which runs on every emitted line) progressively slower. Secret values
// from the bindings are added first, at startup, and are few, so these caps only ever limit workflow-registered masks.
const MAX_MASK_ENTRIES = 1024; // distinct registered strings (a value, its line splits and their Base64 encodings)
const MAX_MASK_BYTES = 256 * 1024; // total characters stored across all registered masks

export class Masker {
  private values = new Set<string>();
  private storedBytes = 0;
  /**
   * Registers a value (and its deterministic encodings) to redact. Returns false once a cap is reached and something
   * could not be stored, so the caller can warn once and stop trusting that later values are masked.
   */
  add(value: string): boolean {
    let accepted = true;
    for (const v of [value, ...value.split(/\r?\n/)]) {
      const t = v.trim();
      if (t.length === 0) continue;
      for (const form of [v, ...encodings(v), ...encodings(t)]) {
        if (this.values.has(form)) continue;
        if (this.values.size >= MAX_MASK_ENTRIES || this.storedBytes + form.length > MAX_MASK_BYTES) {
          accepted = false;
          continue;
        }
        this.values.add(form);
        this.storedBytes += form.length;
      }
    }
    return accepted;
  }
  apply(text: string): string {
    let out = text;
    // Longest first, so a value that contains a shorter registered value is redacted whole.
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
    return out;
  }
}

/**
 * Security review M6: a budget for the workflow-produced log output the runner forwards, per step and for the whole
 * execution. Without it a step could flood the runner's stdout so that the authenticated control events — the public
 * key line, the `verify` and `network` evidence and the final `execution-end` — are pushed past the executor's bounded
 * pod-log read, or rotated out of the kubelet's log, hiding the real result. Only workflow content (step stdout and
 * stderr, step summaries, and the workflow's own `::error/warning/notice::` annotations) is charged here; the runner's
 * own control and verification events are few and small and are never charged, so the result channel can't be crowded
 * out by a flood on the log channel. Lengths are measured in characters, which equal bytes for the ASCII that fills a
 * flood; the point is a hard bound, not an exact byte count.
 */
export class LogBudget {
  private readonly perStep: number;
  private readonly perExecution: number;
  private stepUsed = 0;
  private totalUsed = 0;
  private stepCut = false;
  private execCut = false;
  constructor(perStep: number, perExecution: number) {
    this.perStep = perStep;
    this.perExecution = perExecution;
  }
  /** Begin charging a new step; its per-step allowance is restored (the per-execution total is not). */
  startStep(): void {
    this.stepUsed = 0;
    this.stepCut = false;
  }
  /**
   * How many characters of a `length`-long piece of workflow log content may be forwarded: `length` while within both
   * budgets, fewer when a budget is nearly spent, 0 once one is reached. `notice`, present only the first time each
   * budget is hit (per step, then per execution), is a line for the runner to record as its own annotation.
   */
  take(length: number): { allow: number; notice?: string } {
    if (this.totalUsed >= this.perExecution) {
      const notice = this.execCut ? undefined : `Log output suppressed: this execution reached its log limit of ${this.perExecution} characters (security review M6)`;
      this.execCut = true;
      return { allow: 0, notice };
    }
    if (this.stepUsed >= this.perStep) {
      const notice = this.stepCut ? undefined : `Log output truncated: this step reached its log limit of ${this.perStep} characters (security review M6)`;
      this.stepCut = true;
      return { allow: 0, notice };
    }
    const allow = Math.min(length, this.perStep - this.stepUsed, this.perExecution - this.totalUsed);
    this.stepUsed += allow;
    this.totalUsed += allow;
    if (allow < length && !this.stepCut) {
      this.stepCut = true;
      return { allow, notice: `Log output truncated: this step reached its log limit of ${this.perStep} characters (security review M6)` };
    }
    return { allow };
  }
}

// Security review F4/M6: the log-budget sizes must be real, finite, positive and sane. A malformed value (NaN,
// Infinity, 0, negative, or enormous) would otherwise disable the per-line buffer bound or the log limits. Validated
// at startup, where both the runner and the executor fail closed on a bad value. The defaults match the chart
// (charts/gha-emergency/values.yaml), so the chart and runtime defaults stay consistent.
export const LOG_BUDGET = {
  defaultStepBytes: 1024 * 1024, // 1 MiB per step
  defaultExecutionBytes: 4 * 1024 * 1024, // 4 MiB per execution
  minBytes: 1024, // 1 KiB floor: below this logging is useless and the value is almost certainly a misconfiguration
  maxBytes: 1024 * 1024 * 1024, // 1 GiB ceiling: above this the per-line buffer bound stops being meaningful
};

/** Throws (fail closed) unless both budgets are whole numbers of bytes within [minBytes, maxBytes] (F4/M6). */
export function validateLogBudget(maxStepLogBytes: number, maxLogBytes: number): void {
  for (const [name, v] of [["maxStepLogBytes", maxStepLogBytes], ["maxLogBytes", maxLogBytes]] as const) {
    if (!Number.isInteger(v) || v < LOG_BUDGET.minBytes || v > LOG_BUDGET.maxBytes) {
      throw new Error(`${name} must be a whole number of bytes between ${LOG_BUDGET.minBytes} and ${LOG_BUDGET.maxBytes} (got ${v}); security review F4/M6`);
    }
  }
}

// Security review F2/M6: workflow command files ($GITHUB_OUTPUT/$GITHUB_ENV/$GITHUB_STATE/$GITHUB_PATH) are read under
// strict caps, never whole, so a huge file can neither exhaust the runner's memory nor inflate the authenticated
// step/job control events the outputs travel in. These bounds are independent of the log budget and apply to
// structural data only; $GITHUB_STEP_SUMMARY is ordinary log content and is bounded by the log budget instead.
export const COMMAND_FILE_LIMITS = {
  maxFileBytes: 1024 * 1024, // 1 MiB read cap per command file
  maxEntryBytes: 64 * 1024, // 64 KiB per name=value / heredoc value / PATH line
  maxEntries: 2048, // entries kept per command file
};
const MAX_COMMAND_FILE_BYTES = COMMAND_FILE_LIMITS.maxFileBytes;
const MAX_COMMAND_ENTRY_BYTES = COMMAND_FILE_LIMITS.maxEntryBytes;
const MAX_COMMAND_ENTRIES = COMMAND_FILE_LIMITS.maxEntries;

/** Standard and URL-safe Base64 of a value, with and without padding; only forms long enough not to over-redact. */
function encodings(value: string): string[] {
  const std = Buffer.from(value, "utf8").toString("base64");
  const url = std.replace(/\+/g, "-").replace(/\//g, "_");
  const strip = (s: string) => s.replace(/=+$/, "");
  // At least 8 characters, so short values don't turn common words into "***".
  return [...new Set([std, strip(std), url, strip(url)])].filter((e) => e.length >= 8);
}

const now = () => new Date().toISOString();

/** Parses GitHub's file commands: `name=value` and `name<<DELIMITER` … `DELIMITER`. */
export function parseFileCommands(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const [, name, delim] = heredoc as unknown as [string, string, string];
      const value: string[] = [];
      for (i++; i < lines.length && lines[i] !== delim; i++) value.push(lines[i]!);
      out[name] = value.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export async function runSnapshot(config: RunnerConfig): Promise<StepResult> {
  const started = Date.now();
  const emit = config.emit;
  const masker = new Masker();
  // Steps that printed a deprecated ::set-output::/::save-state:: command, so the runner warns only once each (M1).
  const warnedStdoutCommand = new Set<string>();
  // Security review F1/M6: warn once when a workflow's ::add-mask:: flood hits the mask-registration cap.
  let maskLimitWarned = false;
  const maxMinutes = config.maxMinutes ?? 60;
  // Security review M6: bound the workflow log output the runner forwards, so a flood can't push the authenticated
  // control events out of the executor's log read or the kubelet's retained log. Control events are never charged.
  // F4/M6: the sizes are validated (fail closed) so a malformed value can't disable the buffer bound or the limits.
  const maxStepLogBytes = config.maxStepLogBytes ?? LOG_BUDGET.defaultStepBytes;
  const maxLogBytes = config.maxLogBytes ?? LOG_BUDGET.defaultExecutionBytes;
  validateLogBudget(maxStepLogBytes, maxLogBytes);
  const logBudget = new LogBudget(maxStepLogBytes, maxLogBytes);
  const cmd = config.commands ?? { bash: "bash", sh: "sh", python: "python3", node: "node" };
  // Security review H3: everything the runner emits from workflow-controlled text is masked, then sanitized
  // (control characters, ANSI escapes, bidirectional overrides made visible). Data passed between steps and jobs
  // is masked only, so workflow behaviour doesn't change.
  const display = (text: string) => sanitizeText(masker.apply(text));
  const displayMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [sanitizeText(k), display(v)]));
  const log = (text: string, job?: string, step?: number, stream: "stdout" | "stderr" | "runner" = "runner") => emit({ type: "log", at: now(), job, step, stream, text: display(text) });
  // Security review F3/M6: mask (and sanitize) the full piece of workflow text BEFORE truncating it to the log budget,
  // so a secret straddling a truncation boundary can never leave an unmasked prefix in the forwarded output.
  const maskTruncate = (text: string, allow: number): string => {
    const shown = display(text);
    return allow < text.length ? shown.slice(0, allow) : shown;
  };
  const end = (result: StepResult, reason?: string, outputs: Record<string, string> = {}) => {
    emit({ type: "execution-end", at: now(), result, durationMs: Date.now() - started, outputs: displayMap(outputs), reason: reason && display(reason) });
    return result;
  };
  // Security review M6: when the log budget first cuts a step's or the execution's output, the runner says so once, on
  // its own (unbudgeted) annotation channel, so the reader knows output below was dropped — not that the run stopped.
  const budgetNotice = (notice: string | undefined, job: string, step: number) => {
    if (notice) emit({ type: "annotation", at: now(), job, step, level: "warning", message: notice, source: "runner" });
  };
  // Security review F2/M6: the runner says, on its own channel, when a workflow command file hit a size/entry cap.
  const commandFileNotice = (warning: string | undefined, job: string, step: number) => {
    if (warning) emit({ type: "annotation", at: now(), job, step, level: "warning", message: warning, source: "runner" });
  };

  // 1. Secrets first, so nothing below can print one unmasked.
  const secrets: Record<string, string> = {};
  if (config.secretsDir && existsSync(config.secretsDir)) {
    for (const name of readdirNames(config.secretsDir)) {
      const value = readFileSync(join(config.secretsDir, name), "utf8");
      secrets[name] = value;
      masker.add(value);
    }
  }

  // 2. The snapshot: exactly the one requested, intact and unexpired.
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(config.snapshotDir, "manifest.json"), "utf8")) as Manifest;
  } catch (error) {
    return end("failure", `Snapshot manifest unreadable: ${(error as Error).message}`);
  }
  const digest = await manifestDigest(manifest);
  emit({ type: "execution-start", at: now(), executionId: config.execution.id, digest, workflow: config.execution.workflow, source: { repository: manifest.source?.repository, sha: manifest.source?.sha } });
  const fileOf = (f: { root: string; path: string }) => join(config.snapshotDir, "files", ...f.root.split("/"), ...f.path.split("/"));
  const problems = await verifySnapshot(manifest, async (f) => (existsSync(fileOf(f)) ? new Uint8Array(readFileSync(fileOf(f))) : undefined));
  if (digest !== config.execution.digest) problems.push({ severity: "error", code: "digest", message: `Snapshot digest ${digest} is not the requested ${config.execution.digest}` });
  if (hasErrors(manifest.diagnostics ?? [])) problems.push({ severity: "error", code: "not-executable", message: "The snapshot has validation errors and is not executable" });
  // Security review H1, in depth: re-derive the pipeline from the mounted files, independently of the executor.
  if (!problems.length) {
    const recheck = await revalidateSnapshot(manifest, async (f) => (existsSync(fileOf(f)) ? new Uint8Array(readFileSync(fileOf(f))) : undefined));
    for (const message of recheck.mismatches) problems.push({ severity: "error", code: "manifest-mismatch", message });
    if (!recheck.validation.executable && !recheck.mismatches.length) problems.push({ severity: "error", code: "not-executable", message: "Validation of the mounted files found errors" });
  }
  emit({ type: "verify", at: now(), ok: problems.length === 0, files: manifest.files?.length ?? 0, problems: problems.map((p) => p.message) });
  if (problems.length) return end("failure", "Snapshot verification failed");
  if (!manifest.entryWorkflows.includes(config.execution.workflow)) return end("failure", `${config.execution.workflow} is not an entry workflow of this snapshot`);
  // Security review C1: only the keys the snapshot requires may be mounted. Anything else could be read by workflow
  // code, so nothing runs (key names are reported, values never).
  const required = new Set(manifest.requirements.secrets.map((r) => r.name));
  const unexpected = Object.keys(secrets).filter((n) => !required.has(n));
  if (unexpected.length) return end("failure", `Refusing to run: Secret keys this snapshot does not require are mounted (${unexpected.sort().join(", ")}). Only required keys may be mounted.`);
  for (const r of manifest.requirements.secrets) if (!(r.name in secrets)) return end("failure", `Required secret ${r.name} was not supplied`);

  // 3. Evidence that GitHub is not reachable from here (the execution must not depend on it).
  for (const host of config.networkProbe ?? []) emit({ type: "network", at: now(), host, ...(await probe(host)) });

  const actionsByKey = new Map<string, ActionEntry>(manifest.actions.map((a) => [a.key, a]));
  const workspaceFiles = manifest.files.filter((f) => f.root === WORKSPACE);
  const readSnapshotText = (root: string, path: string) => readFileSync(fileOf({ root, path }), "utf8");
  const actionDir = (a: ActionEntry) => join(config.snapshotDir, "files", ...a.root.split("/"), ...(a.dir ? a.dir.split("/") : []));

  const ref = manifest.source.ref;
  const githubBase = {
    repository: manifest.source.repository,
    repository_owner: manifest.source.repository.split("/")[0],
    sha: manifest.source.sha,
    ref: /^[0-9a-f]{40}$/.test(ref) ? "" : ref.startsWith("refs/") ? ref : `refs/heads/${ref}`,
    ref_name: ref.replace(/^refs\/(?:heads|tags)\//, ""),
    ref_type: ref.startsWith("refs/tags/") ? "tag" : "branch",
    run_id: config.execution.id,
    run_number: 1,
    run_attempt: 1,
    actor: "emergency-operator",
    triggering_actor: "emergency-operator",
    event_name: "workflow_dispatch",
    event: { inputs: config.execution.inputs },
    server_url: "https://github.com",
    api_url: "https://api.github.com",
    head_ref: "",
    base_ref: "",
  };
  let jobCounter = 0;

  const coerceInputs = (specs: Record<string, { type?: string; default?: unknown }>, given: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(specs)) {
      const raw = name in given ? given[name] : spec.default;
      if (raw === undefined) continue;
      out[name] = spec.type === "boolean" ? raw === true || String(raw).toLowerCase() === "true" : spec.type === "number" ? Number(raw) : raw;
    }
    return out;
  };

  /** Runs a workflow's jobs. Returns each job's record and the workflow's result. */
  const runWorkflow = async (wf: WorkflowDef, inputs: Record<string, unknown>, wfSecrets: Record<string, string>, prefix: string, depth: number): Promise<{ result: StepResult; jobs: Record<string, JobRecord> }> => {
    const records: Record<string, JobRecord> = {};
    const pending = [...wf.jobs];
    let failed = false;
    while (pending.length) {
      const i = pending.findIndex((j) => j.needs.every((n) => n in records));
      if (i < 0) {
        for (const j of pending) records[j.id] = { result: "skipped", outputs: {} };
        break;
      }
      const job = pending.splice(i, 1)[0]!;
      const key = prefix + job.id;
      const needs = Object.fromEntries(job.needs.map((n) => [n, records[n]!]));
      const needResults = job.needs.map((n) => records[n]!.result);
      const status: JobStatus = needResults.includes("failure") ? "failure" : needResults.includes("cancelled") ? "cancelled" : needResults.includes("skipped") ? "skipped" : "success";
      const contexts: Contexts = { github: { ...githubBase, workflow: wf.name ?? wf.path, job: job.id }, inputs, secrets: wfSecrets, vars: config.execution.variables, needs, env: { ...wf.env }, runner: runnerContext(""), matrix: {}, strategy: {} };
      emit({ type: "job-start", at: now(), job: key, name: display(job.name ? interpolateString(job.name, { contexts }) : job.id), workflow: wf.path, needs: job.needs.map((n) => prefix + n) });
      let run: boolean;
      try {
        run = truthy(evaluate(parseCondition(job.if), { contexts, status }));
      } catch (error) {
        records[job.id] = { result: "failure", outputs: {} };
        emit({ type: "job-end", at: now(), job: key, result: "failure", outputs: {}, reason: display(`if: ${(error as Error).message}`) });
        failed = true;
        continue;
      }
      if (!run) {
        records[job.id] = { result: "skipped", outputs: {} };
        emit({ type: "job-end", at: now(), job: key, result: "skipped", outputs: {}, reason: status === "success" ? "if: condition was false" : `a needed job ${status === "failure" ? "failed" : "was skipped or cancelled"}` });
        continue;
      }
      const record = job.uses ? await runCall(job, contexts, wfSecrets, key, depth) : await runStepsJob(job, wf, contexts, key);
      const continueOnError = truthy(typeof job.continueOnError === "string" ? interpolate(job.continueOnError, { contexts }) : job.continueOnError);
      records[job.id] = record;
      if (record.result === "failure" && !continueOnError) failed = true;
    }
    return { result: failed ? "failure" : "success", jobs: records };
  };

  const runCall = async (job: JobDef, contexts: Contexts, callerSecrets: Record<string, string>, key: string, depth: number): Promise<JobRecord> => {
    const u = parseUses(job.uses!);
    let text: string;
    let path: string;
    try {
      if (u.kind === "local") {
        path = u.path;
        text = readSnapshotText(WORKSPACE, path);
      } else if (u.kind === "remote") {
        const root = manifest.roots.find((r) => r.repository.toLowerCase() === `${u.owner}/${u.repo}`.toLowerCase() && (r.ref === u.ref || r.sha === u.ref) && r.kind === "workflow");
        if (!root) throw new Error(`${job.uses} is not in the snapshot`);
        path = u.path;
        text = readSnapshotText(root.id, path);
      } else throw new Error(`Unsupported reusable workflow reference ${job.uses}`);
    } catch (error) {
      emit({ type: "job-end", at: now(), job: key, result: "failure", outputs: {}, reason: display((error as Error).message) });
      return { result: "failure", outputs: {} };
    }
    const callee = parseWorkflow(path, text);
    const given = Object.fromEntries(Object.entries(job.with).map(([k, v]) => [k, typeof v === "string" ? interpolate(v, { contexts }) : v]));
    const calleeSecrets = job.secrets === "inherit" ? { ...callerSecrets } : Object.fromEntries(Object.entries(job.secrets).map(([k, v]) => [k, interpolateString(v, { contexts })]));
    log(`Calling reusable workflow ${job.uses}`, key);
    const inner = await runWorkflow(callee, coerceInputs(callee.call?.inputs ?? {}, given), calleeSecrets, `${key}/`, depth + 1);
    const outputs: Record<string, string> = {};
    const jobsCtx = Object.fromEntries(Object.entries(inner.jobs).map(([id, r]) => [id, r]));
    for (const [name, expr] of Object.entries(callee.call?.outputs ?? {})) {
      try {
        outputs[name] = masker.apply(interpolateString(expr, { contexts: { ...contexts, jobs: jobsCtx } }));
      } catch (error) {
        log(`Output ${name}: ${(error as Error).message}`, key);
      }
    }
    emit({ type: "job-end", at: now(), job: key, result: inner.result, outputs: displayMap(outputs) });
    return { result: inner.result, outputs };
  };

  type StepState = { env: Record<string, string>; path: string[]; steps: Record<string, { outputs: Record<string, string>; outcome: StepResult; conclusion: StepResult }>; failed: boolean; posts: (() => Promise<void>)[]; stepNo: number };

  const runStepsJob = async (job: JobDef, wf: WorkflowDef, baseContexts: Contexts, key: string): Promise<JobRecord> => {
    const jobDir = join(config.workDir, "jobs", String(++jobCounter));
    const workspace = join(jobDir, "workspace");
    const temp = join(jobDir, "temp");
    for (const d of [workspace, temp, join(jobDir, "home"), join(jobDir, "tool-cache")]) mkdirSync(d, { recursive: true });
    for (const f of workspaceFiles) restore(f, workspace);
    log(`Workspace restored from snapshot: ${workspaceFiles.length} files at ${manifest.source.sha.slice(0, 7)}`, key);
    const deadline = Date.now() + Math.min(job.timeoutMinutes ?? 360, maxMinutes) * 60_000;
    const state: StepState = { env: { ...wf.env, ...stringMap(job.env, baseContexts) }, path: [], steps: {}, failed: false, posts: [], stepNo: 0 };
    const jobContexts: Contexts = { ...baseContexts, env: state.env, steps: state.steps, job: { status: "success" }, runner: runnerContext(temp), github: { ...(baseContexts.github as object), workspace } };
    const shell = job.defaults.shell ?? wf.defaults.shell;
    const workingDirectory = job.defaults.workingDirectory ?? wf.defaults.workingDirectory;
    await runSteps(job.steps, state, jobContexts, { key, workspace, temp, jobDir, deadline, shell, workingDirectory, actionPath: "" });
    for (const post of state.posts.reverse()) await post();
    const result: StepResult = state.failed ? "failure" : "success";
    const outputs: Record<string, string> = {};
    for (const [name, expr] of Object.entries(job.outputs)) {
      try {
        outputs[name] = masker.apply(interpolateString(expr, { contexts: { ...jobContexts, steps: state.steps }, status: result === "failure" ? "failure" : "success" }));
      } catch (error) {
        log(`Output ${name}: ${(error as Error).message}`, key);
      }
    }
    emit({ type: "job-end", at: now(), job: key, result, outputs: displayMap(outputs) });
    return { result, outputs };
  };

  type Place = { key: string; workspace: string; temp: string; jobDir: string; deadline: number; shell?: string; workingDirectory?: string; actionPath: string; labelPrefix?: string };

  const runSteps = async (steps: StepDef[], state: StepState, contexts: Contexts, place: Place) => {
    for (const step of steps) {
      const no = ++state.stepNo;
      const ctx: Contexts = { ...contexts, env: { ...(contexts.env as object), ...state.env }, steps: state.steps };
      const status: JobStatus = state.failed ? "failure" : "success";
      let label = step.name ?? step.id ?? (step.uses ? `Run ${step.uses}` : `Run ${step.run?.split("\n")[0]?.slice(0, 60)}`);
      try {
        label = interpolateString(label, { contexts: ctx, status });
      } catch {
        // keep the raw label
      }
      emit({ type: "step-start", at: now(), job: place.key, step: no, name: display((place.labelPrefix ?? "") + label), kind: step.run !== undefined ? "run" : step.uses ? "uses" : "unknown", detail: step.uses });
      const t0 = Date.now();
      const finish = (outcome: StepResult, exitCode: number | null, outputs: Record<string, string>, reason?: string) => {
        let continueOnError: boolean;
        try {
          continueOnError = truthy(typeof step.continueOnError === "string" ? interpolate(step.continueOnError, { contexts: ctx }) : step.continueOnError);
        } catch {
          continueOnError = false;
        }
        const conclusion: StepResult = outcome === "failure" && continueOnError ? "success" : outcome;
        if (conclusion === "failure") state.failed = true;
        const masked = displayMap(outputs);
        if (step.id) state.steps[step.id] = { outputs, outcome, conclusion };
        emit({ type: "step-end", at: now(), job: place.key, step: no, outcome, conclusion, exitCode, durationMs: Date.now() - t0, outputs: masked, reason: reason && display(reason) });
      };
      let run: boolean;
      try {
        run = truthy(evaluate(parseCondition(step.if), { contexts: ctx, status }));
      } catch (error) {
        finish("failure", null, {}, `if: ${(error as Error).message}`);
        continue;
      }
      if (!run) {
        finish("skipped", null, {}, state.failed ? "an earlier step failed" : "if: condition was false");
        continue;
      }
      if (Date.now() >= place.deadline) {
        finish("cancelled", null, {}, "job timeout reached");
        state.failed = true;
        continue;
      }
      try {
        const r = await runOne(step, no, state, ctx, place);
        finish(r.outcome, r.exitCode, r.outputs, r.reason);
      } catch (error) {
        finish("failure", null, {}, (error as Error).message);
      }
    }
  };

  type StepRun = { outcome: StepResult; exitCode: number | null; outputs: Record<string, string>; reason?: string };

  const runOne = async (step: StepDef, no: number, state: StepState, ctx: Contexts, place: Place): Promise<StepRun> => {
    const evalCtx = { contexts: ctx, status: (state.failed ? "failure" : "success") as JobStatus };
    const stepEnv = { ...(ctx.env as Record<string, string>), ...Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, interpolateString(v, evalCtx)])) };
    const timeoutAt = Math.min(place.deadline, Date.now() + Math.min(step.timeoutMinutes ?? maxMinutes, maxMinutes) * 60_000);
    if (step.run !== undefined) {
      const shell = (step.shell ?? place.shell ?? "").trim();
      const wd = resolveInside(place.workspace, step.workingDirectory ?? place.workingDirectory, evalCtx);
      const { argv, ext } = shellCommand(shell, cmd);
      // Security review M1: each ${{ }} value is passed to the script as an environment variable and referenced as
      // data, never pasted into the script text, so a value can't become shell or Python syntax. A context that
      // can't be made safe (validation already refuses it) is refused here too.
      let subst: { script: string; env: Record<string, string> };
      try {
        subst = substituteRunWithContext(step.run, ext === ".py" ? "python" : "shell", evalCtx);
      } catch (error) {
        if (error instanceof UnsafeExpressionContextError) return { outcome: "failure", exitCode: null, outputs: {}, reason: `Refusing to run this step: ${error.message}` };
        throw error;
      }
      const file = join(place.temp, `${randomUUID()}${ext}`);
      writeFileSync(file, subst.script);
      return runProcess(argv.map((a) => (a === "{0}" ? file : a)), wd, { ...stepEnv, ...subst.env }, state, place, no, step.id, timeoutAt);
    }
    const u = parseUses(step.uses ?? "");
    if (isCheckout(u)) {
      log("actions/checkout: the packaged workspace at the snapshot commit is already in place (no Git or GitHub access)", place.key, no);
      return { outcome: "success", exitCode: 0, outputs: { ref: githubBase.ref, commit: manifest.source.sha } };
    }
    const entry = actionsByKey.get(step.uses ?? "");
    if (!entry || entry.substitutedBy) return { outcome: "failure", exitCode: null, outputs: {}, reason: `${step.uses} is not packaged in this snapshot` };
    const dir = actionDir(entry);
    const action = parseAction(entry.key, readSnapshotText(entry.root, entry.file));
    const inputs: Record<string, string> = {};
    for (const [name, spec] of Object.entries(action.inputs)) {
      const given = Object.keys(step.with).find((k) => k.toLowerCase() === name.toLowerCase());
      if (given !== undefined) inputs[name] = interpolateString(step.with[given]!, evalCtx);
      else if (spec.default !== undefined) inputs[name] = interpolateString(spec.default, evalCtx);
    }
    for (const [k, v] of Object.entries(step.with)) if (!(k in inputs) && !Object.keys(inputs).some((n) => n.toLowerCase() === k.toLowerCase())) inputs[k] = interpolateString(v, evalCtx);
    if (action.using === "node") return runNodeAction(action, entry, dir, inputs, stepEnv, state, place, no, step.id, timeoutAt);
    if (action.using === "composite") return runComposite(action, dir, inputs, stepEnv, state, ctx, place, no);
    return { outcome: "failure", exitCode: null, outputs: {}, reason: `${action.runtime} actions are not supported` };
  };

  const runNodeAction = async (action: ActionDef, entry: ActionEntry, dir: string, inputs: Record<string, string>, env: Record<string, string>, state: StepState, place: Place, no: number, id: string | undefined, timeoutAt: number): Promise<StepRun> => {
    const inputEnv = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.replace(/ /g, "_").toUpperCase()}`, v]));
    const main = join(dir, ...action.main!.replace(/^\.\//, "").split("/"));
    const stateFile = join(place.temp, `state-${randomUUID()}`);
    const extra = { ...inputEnv, GITHUB_ACTION_PATH: dir, GITHUB_ACTION_REPOSITORY: entry.root === WORKSPACE ? "" : entry.root.split("/").slice(1, 3).join("/") };
    const r = await runProcess([cmd.node, main], place.workspace, { ...env, ...extra }, state, place, no, id, timeoutAt, stateFile);
    if (action.post) {
      // Security review F2/M6: $GITHUB_STATE is a workflow command file too; read it under the same caps (never whole).
      const stateRead: { entries: Record<string, string>; warning?: string } = existsSync(stateFile) ? readCommandEntries(stateFile, "GITHUB_STATE") : { entries: {} };
      const savedState = stateRead.entries;
      commandFileNotice(stateRead.warning, place.key, no);
      const postIf = action.postIf ?? "always()";
      const post = join(dir, ...action.post.replace(/^\.\//, "").split("/"));
      state.posts.push(async () => {
        const status: JobStatus = state.failed ? "failure" : "success";
        const postNo = ++state.stepNo;
        emit({ type: "step-start", at: now(), job: place.key, step: postNo, name: `Post ${entry.key}`, kind: "post", detail: entry.key });
        const t0 = Date.now();
        if (!truthy(evaluate(parseCondition(postIf), { contexts: {}, status }))) {
          emit({ type: "step-end", at: now(), job: place.key, step: postNo, outcome: "skipped", conclusion: "skipped", exitCode: null, durationMs: 0, outputs: {}, reason: `post-if: ${postIf}` });
          return;
        }
        const stateEnv = Object.fromEntries(Object.entries(savedState).map(([k, v]) => [`STATE_${k}`, v]));
        const pr = await runProcess([cmd.node, post], place.workspace, { ...env, ...extra, ...stateEnv }, state, place, postNo, undefined, Math.max(Date.now() + 60_000, place.deadline));
        if (pr.outcome === "failure") state.failed = true;
        emit({ type: "step-end", at: now(), job: place.key, step: postNo, outcome: pr.outcome, conclusion: pr.outcome, exitCode: pr.exitCode, durationMs: Date.now() - t0, outputs: {}, reason: pr.reason });
      });
    }
    return r;
  };

  const runComposite = async (action: ActionDef, dir: string, inputs: Record<string, string>, env: Record<string, string>, outer: StepState, ctx: Contexts, place: Place, no: number): Promise<StepRun> => {
    const inner: StepState = { env: {}, path: outer.path, steps: {}, failed: false, posts: outer.posts, stepNo: outer.stepNo };
    const contexts: Contexts = { ...ctx, inputs, env, steps: inner.steps, github: { ...(ctx.github as object), action_path: dir } };
    log(`Composite action: ${action.steps.length} steps`, place.key, no);
    await runSteps(action.steps, inner, contexts, { ...place, actionPath: dir, shell: undefined, workingDirectory: undefined, labelPrefix: `${place.labelPrefix ?? ""}${action.name ?? "composite"} › ` });
    outer.stepNo = inner.stepNo;
    Object.assign(outer.env, inner.env);
    const outputs: Record<string, string> = {};
    for (const [name, expr] of Object.entries(action.outputs)) if (expr !== undefined) outputs[name] = interpolateString(expr, { contexts: { ...contexts, steps: inner.steps } });
    return { outcome: inner.failed ? "failure" : "success", exitCode: inner.failed ? 1 : 0, outputs, reason: inner.failed ? "a step of the composite action failed" : undefined };
  };

  /** Runs one process with GitHub's file commands and workflow-command parsing; masks everything it emits. */
  const runProcess = async (argv: string[], cwd: string, env: Record<string, string>, state: StepState, place: Place, no: number, id: string | undefined, timeoutAt: number, stateFile?: string): Promise<StepRun> => {
    logBudget.startStep(); // Security review M6: each step that produces output gets a fresh per-step log allowance.
    const files = Object.fromEntries(["output", "env", "path", "state", "summary"].map((n) => [n, n === "state" && stateFile ? stateFile : join(place.temp, `${n}-${randomUUID()}`)]));
    for (const f of Object.values(files)) writeFileSync(f, "", { flag: "a" });
    const processEnv: Record<string, string> = {
      ...baseEnv(),
      HOME: join(place.jobDir, "home"),
      CI: "true",
      GITHUB_ACTIONS: "true",
      EMERGENCY_EXECUTION: "true",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: process.arch === "arm64" ? "ARM64" : "X64",
      RUNNER_TEMP: place.temp,
      RUNNER_TOOL_CACHE: join(place.jobDir, "tool-cache"),
      GITHUB_WORKSPACE: place.workspace,
      GITHUB_REPOSITORY: githubBase.repository,
      GITHUB_REPOSITORY_OWNER: String(githubBase.repository_owner),
      GITHUB_SHA: githubBase.sha,
      GITHUB_REF: githubBase.ref,
      GITHUB_REF_NAME: githubBase.ref_name,
      GITHUB_RUN_ID: githubBase.run_id,
      GITHUB_RUN_NUMBER: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: githubBase.event_name,
      GITHUB_EVENT_PATH: eventFile(place.temp),
      GITHUB_SERVER_URL: githubBase.server_url,
      GITHUB_API_URL: githubBase.api_url,
      GITHUB_ACTOR: githubBase.actor,
      GITHUB_JOB: place.key,
      GITHUB_ACTION: id ?? `__step${no}`,
      GITHUB_ACTION_PATH: place.actionPath,
      GITHUB_OUTPUT: files.output!,
      GITHUB_ENV: files.env!,
      GITHUB_PATH: files.path!,
      GITHUB_STATE: files.state!,
      GITHUB_STEP_SUMMARY: files.summary!,
      ...env,
    };
    if (state.path.length) processEnv.PATH = [...state.path, processEnv.PATH].join(":");
    const outputs: Record<string, string> = {};
    const result = await new Promise<{ code: number | null; reason?: string }>((done) => {
      let child;
      try {
        child = spawn(argv[0]!, argv.slice(1), { cwd, env: processEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      } catch (error) {
        done({ code: null, reason: (error as Error).message });
        return;
      }
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        done({ code: null, reason: "step timeout reached" });
      }, Math.max(0, timeoutAt - Date.now()));
      const lines = (stream: "stdout" | "stderr") => {
        let buf = "";
        return (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const parts = buf.split(/\r?\n/);
          buf = parts.pop()!;
          for (const line of parts) handleLine(line, stream, place, no);
          // Security review M6: a step can print without newlines; flush an over-long pending line so the buffer (and
          // any single log event) can't grow without bound. The budget drops what it must once the line is handled.
          if (buf.length > maxStepLogBytes) {
            handleLine(buf, stream, place, no);
            buf = "";
          }
        };
      };
      const out = lines("stdout");
      const err = lines("stderr");
      child.stdout!.on("data", out);
      child.stderr!.on("data", err);
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ code: null, reason: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        out(Buffer.from("\n"));
        err(Buffer.from("\n"));
        done({ code });
      });
    });
    // Security review F2/M6: read the workflow command files under strict, independent caps (never whole), so a huge
    // file can neither exhaust the runner's memory nor inflate the authenticated step/job events the outputs ride in.
    const outputRead = readCommandEntries(files.output!, "GITHUB_OUTPUT");
    Object.assign(outputs, outputRead.entries);
    commandFileNotice(outputRead.warning, place.key, no);
    const envRead = readCommandEntries(files.env!, "GITHUB_ENV");
    Object.assign(state.env, envRead.entries);
    commandFileNotice(envRead.warning, place.key, no);
    const pathRead = readPathEntries(files.path!);
    for (const p of pathRead.paths) state.path.unshift(p);
    commandFileNotice(pathRead.warning, place.key, no);
    // GITHUB_STEP_SUMMARY is log content: read under the command-file cap (never whole), then forward it through the
    // log budget, masking before truncation (F2/F3/M6), so it can neither exhaust memory nor flood the executor's log.
    const summary = readCapped(files.summary!, MAX_COMMAND_FILE_BYTES + 1);
    if (summary.truncated) commandFileNotice(`GITHUB_STEP_SUMMARY: over ${MAX_COMMAND_FILE_BYTES} bytes; the excess was dropped (security review M6)`, place.key, no);
    if (summary.text.trim()) {
      const { allow, notice } = logBudget.take(summary.text.length);
      if (allow > 0) emit({ type: "log", at: now(), job: place.key, step: no, stream: "runner", text: `Step summary:\n${maskTruncate(summary.text, allow).trimEnd()}` });
      budgetNotice(notice, place.key, no);
    }
    const outcome: StepResult = result.reason === "step timeout reached" ? "cancelled" : result.code === 0 ? "success" : "failure";
    return { outcome: outcome === "cancelled" ? "failure" : outcome, exitCode: result.code, outputs, reason: result.reason ?? (result.code === 0 ? undefined : `exit code ${result.code}`) };
  };

  const handleLine = (line: string, stream: "stdout" | "stderr", place: Place, no: number) => {
    const cmdMatch = /^::([a-z-]+)(?:\s+(?:[^:]*))?::(.*)$/.exec(line);
    if (cmdMatch) {
      const [, name, value = ""] = cmdMatch as unknown as [string, string, string?];
      if (name === "add-mask") {
        // Security review F1/M6: register the mask under the Masker's caps, and warn once if the cap is reached.
        if (!masker.add(value) && !maskLimitWarned) {
          maskLimitWarned = true;
          emit({ type: "annotation", at: now(), job: place.key, step: no, level: "warning", message: "Mask registration limit reached; further ::add-mask:: commands are ignored (security review F1/M6)", source: "runner" });
        }
        // The acknowledgement line is workflow-triggered content, so charge it to the log budget like any other line;
        // a flood of ::add-mask:: commands can no longer bypass the per-step and per-execution limits.
        const { allow, notice } = logBudget.take("::add-mask::***".length);
        if (allow > 0) log("::add-mask::***", place.key, no, stream);
        budgetNotice(notice, place.key, no);
        return;
      }
      if (name === "set-output" || name === "save-state") {
        // Security review M1: GitHub deprecated the stdout ::set-output:: / ::save-state:: commands, and workflow
        // stdout is untrusted, so the runner does not act on them. The line stays visible as ordinary log data, and
        // the runner warns once per step. Outputs and state come from the $GITHUB_OUTPUT and $GITHUB_STATE files.
        const seen = `${place.key}#${no}`;
        if (!warnedStdoutCommand.has(seen)) {
          warnedStdoutCommand.add(seen);
          emit({ type: "annotation", at: now(), job: place.key, step: no, level: "warning", message: `::${name}:: on stdout is ignored (GitHub deprecated it); write to the $GITHUB_${name === "set-output" ? "OUTPUT" : "STATE"} file instead`, source: "runner" });
        }
        // fall through: emit the raw line as log data
      } else if (name === "error" || name === "warning" || name === "notice") {
        // Security review M6: a workflow annotation is workflow content; charge it to the log budget so a flood of
        // ::notice:: lines can't crowd out the control events either.
        const { allow, notice } = logBudget.take(value.length);
        if (allow > 0) emit({ type: "annotation", at: now(), job: place.key, step: no, level: name, message: maskTruncate(value, allow), source: "workflow" });
        budgetNotice(notice, place.key, no);
      }
    }
    // Security review M6: step stdout/stderr is workflow content. Forward only what the per-step and per-execution log
    // budgets allow; beyond that, drop it (with a one-time runner notice) so the authenticated result channel survives.
    // F3/M6: mask before truncating (maskTruncate), so a secret at the boundary can't leak an unmasked prefix.
    const { allow, notice } = logBudget.take(line.length);
    if (allow > 0) emit({ type: "log", at: now(), job: place.key, step: no, stream, text: maskTruncate(line, allow) });
    budgetNotice(notice, place.key, no);
  };

  const restore = (f: FileEntry, workspace: string) => {
    const target = join(workspace, ...f.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(fileOf(f), target);
    chmodSync(target, f.executable ? 0o755 : 0o644);
  };

  const resolveInside = (workspace: string, wd: string | undefined, evalCtx: { contexts: Contexts }) => {
    if (!wd) return workspace;
    const clean = normalizePath(interpolateString(wd, evalCtx).replace(/^\.\//, ""));
    if (clean === null) throw new Error(`working-directory ${wd} is outside the workspace`);
    const full = resolve(workspace, clean);
    if (relative(workspace, full).startsWith("..") || (full !== workspace && !full.startsWith(workspace + sep))) throw new Error(`working-directory ${wd} is outside the workspace`);
    mkdirSync(full, { recursive: true });
    return full;
  };

  const eventFile = (temp: string) => {
    const f = join(temp, "event.json");
    if (!existsSync(f)) writeFileSync(f, JSON.stringify({ inputs: config.execution.inputs }));
    return f;
  };

  // 4. The entry workflow.
  try {
    const wf = parseWorkflow(config.execution.workflow, readSnapshotText(WORKSPACE, config.execution.workflow));
    const specs = { ...wf.dispatchInputs, ...(wf.call?.inputs ?? {}) };
    for (const [name, spec] of Object.entries(specs)) if (spec.required && !(name in config.execution.inputs) && spec.default === undefined) return end("failure", `Required input ${name} was not supplied`);
    const inputs = coerceInputs(specs, config.execution.inputs);
    const secretsCtx = Object.fromEntries(manifest.requirements.secrets.map((r) => [r.name, secrets[r.name] ?? ""]));
    const outcome = await runWorkflow(wf, inputs, secretsCtx, "", 0);
    const outputs: Record<string, string> = {};
    if (wf.call) for (const [name, expr] of Object.entries(wf.call.outputs)) outputs[name] = masker.apply(stringify(interpolate(expr, { contexts: { jobs: outcome.jobs, inputs } })));
    return end(outcome.result, outcome.result === "failure" ? "one or more jobs failed" : undefined, outputs);
  } catch (error) {
    return end("failure", `Runner error: ${(error as Error).message}`);
  }
}

/**
 * Reads at most `max` bytes from the start of a file, in bounded chunks, so a huge workflow-written file is never
 * loaded whole (security review F2/M6). `truncated` reports whether the file was longer than `max`.
 */
function readCapped(path: string, max: number): { text: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(Math.min(max, 64 * 1024));
    const parts: Buffer[] = [];
    let total = 0;
    while (total < max) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, max - total), total);
      if (n === 0) break;
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    // One extra byte, read but not kept, tells us whether the file was longer than the cap.
    const truncated = readSync(fd, Buffer.alloc(1), 0, 1, total) > 0;
    return { text: Buffer.concat(parts).toString("utf8"), truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads a GitHub command file ($GITHUB_OUTPUT/$GITHUB_ENV/$GITHUB_STATE) under strict caps (security review F2/M6):
 * at most MAX_COMMAND_FILE_BYTES read from disk, at most MAX_COMMAND_ENTRIES kept, each value capped at
 * MAX_COMMAND_ENTRY_BYTES. Returns the bounded entries and a single warning summarising any cap that was hit.
 */
export function readCommandEntries(path: string, label: string): { entries: Record<string, string>; warning?: string } {
  const { text, truncated } = readCapped(path, MAX_COMMAND_FILE_BYTES + 1);
  const parsed = parseFileCommands(truncated ? text.slice(0, MAX_COMMAND_FILE_BYTES) : text);
  const warnings: string[] = [];
  if (truncated) warnings.push(`over ${MAX_COMMAND_FILE_BYTES} bytes; the excess was dropped`);
  const entries: Record<string, string> = {};
  let longEntry = false;
  for (const [k, v] of Object.entries(parsed)) {
    if (Object.keys(entries).length >= MAX_COMMAND_ENTRIES) {
      warnings.push(`more than ${MAX_COMMAND_ENTRIES} entries; the rest were dropped`);
      break;
    }
    if (v.length > MAX_COMMAND_ENTRY_BYTES) {
      entries[k] = v.slice(0, MAX_COMMAND_ENTRY_BYTES);
      if (!longEntry) {
        longEntry = true;
        warnings.push(`at least one entry over ${MAX_COMMAND_ENTRY_BYTES} bytes; truncated`);
      }
    } else entries[k] = v;
  }
  return { entries, warning: warnings.length ? `${label}: ${warnings.join("; ")} (security review M6)` : undefined };
}

/** Reads $GITHUB_PATH under the same caps; returns the path entries to prepend and any warning (F2/M6). */
export function readPathEntries(path: string): { paths: string[]; warning?: string } {
  const { text, truncated } = readCapped(path, MAX_COMMAND_FILE_BYTES + 1);
  const warnings: string[] = [];
  if (truncated) warnings.push(`over ${MAX_COMMAND_FILE_BYTES} bytes; the excess was dropped`);
  const paths: string[] = [];
  let longEntry = false;
  for (const p of (truncated ? text.slice(0, MAX_COMMAND_FILE_BYTES) : text).split(/\r?\n/).filter(Boolean)) {
    if (paths.length >= MAX_COMMAND_ENTRIES) {
      warnings.push(`more than ${MAX_COMMAND_ENTRIES} entries; the rest were dropped`);
      break;
    }
    if (p.length > MAX_COMMAND_ENTRY_BYTES) {
      if (!longEntry) {
        longEntry = true;
        warnings.push(`at least one entry over ${MAX_COMMAND_ENTRY_BYTES} bytes; skipped`);
      }
      continue;
    }
    paths.push(p);
  }
  return { paths, warning: warnings.length ? `GITHUB_PATH: ${warnings.join("; ")} (security review M6)` : undefined };
}

/** Kubernetes Secret volumes hold each key as a symlink next to "..data" entries; only plain names are secrets. */
function readdirNames(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(n));
}

function runnerContext(temp: string) {
  return { os: "Linux", arch: process.arch === "arm64" ? "ARM64" : "X64", name: "gha-emergency-runner", temp, tool_cache: "", environment: "self-hosted" };
}

function stringMap(env: Record<string, string>, contexts: Contexts): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, interpolateString(v, { contexts })]));
}

/** A minimal process environment: the runner's own variables (Kubernetes service addresses, …) are not passed on. */
function baseEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" };
}

function shellCommand(shell: string, cmd: { bash: string; sh: string; python: string }): { argv: string[]; ext: string } {
  if (shell === "") return { argv: [cmd.bash, "-e", "{0}"], ext: ".sh" };
  if (shell === "bash") return { argv: [cmd.bash, "--noprofile", "--norc", "-eo", "pipefail", "{0}"], ext: ".sh" };
  if (shell === "sh") return { argv: [cmd.sh, "-e", "{0}"], ext: ".sh" };
  if (shell === "python") return { argv: [cmd.python, "{0}"], ext: ".py" };
  const parts = shell.split(/\s+/);
  if (/^(?:bash|sh|python3?)$/.test(parts[0]!) && parts.includes("{0}")) {
    const exe = parts[0] === "bash" ? cmd.bash : parts[0] === "sh" ? cmd.sh : cmd.python;
    return { argv: [exe, ...parts.slice(1)], ext: parts[0]!.startsWith("python") ? ".py" : ".sh" };
  }
  throw new Error(`shell: ${shell} is not available in the emergency runner`);
}

async function probe(host: string): Promise<{ reachable: boolean; detail: string }> {
  let address: string;
  try {
    address = (await withTimeout(lookup(host), 3000)).address;
  } catch (error) {
    return { reachable: false, detail: `DNS lookup failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` };
  }
  return new Promise((done) => {
    const socket = connect({ host: address, port: 443, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      done({ reachable: true, detail: `TCP connection to ${address}:443 succeeded` });
    });
    socket.once("timeout", () => {
      socket.destroy();
      done({ reachable: false, detail: `TCP connection to ${address}:443 timed out` });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => done({ reachable: false, detail: `TCP connection to ${address}:443 failed (${error.code ?? error.message})` }));
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}
