// Workflow and action definitions for emergency execution: parsed from the original YAML, shared by snapshot
// preparation, validation and the runner. Pure apart from the `yaml` parser.
import { parse } from "yaml";

export type Severity = "error" | "warning" | "info";
/** A finding about a snapshot. Errors block execution; warnings and notes are shown with the snapshot. */
export type Diagnostic = { severity: Severity; code: string; message: string; where?: string };

export type StepDef = {
  index: number;
  id?: string;
  name?: string;
  if?: unknown;
  run?: string;
  shell?: string;
  uses?: string;
  with: Record<string, string>;
  env: Record<string, string>;
  workingDirectory?: string;
  continueOnError: unknown;
  timeoutMinutes?: number;
};

export type JobDef = {
  id: string;
  name?: string;
  needs: string[];
  if?: unknown;
  runsOn?: unknown;
  env: Record<string, string>;
  outputs: Record<string, string>;
  steps: StepDef[];
  /** A reusable workflow called by this job. */
  uses?: string;
  with: Record<string, unknown>;
  secrets: Record<string, string> | "inherit";
  defaults: { shell?: string; workingDirectory?: string };
  timeoutMinutes?: number;
  continueOnError: unknown;
  /** Keys present in the YAML that the emergency runner does not reproduce (strategy, services, …). */
  unsupportedKeys: string[];
  ignoredKeys: string[];
};

export type InputSpec = { type?: string; required: boolean; default?: unknown; description?: string };

export type WorkflowDef = {
  path: string;
  name?: string;
  triggers: string[];
  /** `on.workflow_call`: present when the workflow can be called. */
  call?: { inputs: Record<string, InputSpec>; outputs: Record<string, string>; secrets: Record<string, { required: boolean }> };
  dispatchInputs: Record<string, InputSpec>;
  env: Record<string, string>;
  defaults: { shell?: string; workingDirectory?: string };
  jobs: JobDef[];
};

export type ActionDef = {
  name?: string;
  using: "node" | "composite" | "docker" | "unsupported";
  /** The raw `runs.using` value, e.g. "node20". */
  runtime: string;
  main?: string;
  pre?: string;
  post?: string;
  postIf?: string;
  inputs: Record<string, { required: boolean; default?: string }>;
  outputs: Record<string, string | undefined>;
  steps: StepDef[];
};

const JOB_UNSUPPORTED = ["strategy", "services", "container"];
const JOB_IGNORED = ["runs-on", "permissions", "concurrency", "environment"];
const JOB_KNOWN = new Set(["name", "needs", "if", "env", "outputs", "steps", "uses", "with", "secrets", "defaults", "timeout-minutes", "continue-on-error", ...JOB_UNSUPPORTED, ...JOB_IGNORED]);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === "string" ? v : String(v));
const strMap = (v: unknown): Record<string, string> => (isRec(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x) ?? ""])) : {});

export class DefinitionError extends Error {}

function parseYaml(text: string, what: string): Rec {
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 100 });
  } catch (error) {
    throw new DefinitionError(`${what}: invalid YAML (${(error as Error).message.split("\n")[0]})`);
  }
  if (!isRec(doc)) throw new DefinitionError(`${what}: expected a mapping at the top level`);
  return doc;
}

function parseInputs(v: unknown): Record<string, InputSpec> {
  if (!isRec(v)) return {};
  return Object.fromEntries(
    Object.entries(v).map(([k, spec]) => {
      const s = isRec(spec) ? spec : {};
      return [k, { type: str(s.type), required: s.required === true, default: s.default, description: str(s.description) }];
    }),
  );
}

function parseSteps(v: unknown, where: string): StepDef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new DefinitionError(`${where}: steps must be a list`);
  return v.map((raw, index) => {
    if (!isRec(raw)) throw new DefinitionError(`${where}: step ${index + 1} must be a mapping`);
    const timeout = raw["timeout-minutes"];
    return {
      index,
      id: str(raw.id),
      name: str(raw.name),
      if: raw.if,
      run: str(raw.run),
      shell: str(raw.shell),
      uses: str(raw.uses),
      with: strMap(raw.with),
      env: strMap(raw.env),
      workingDirectory: str(raw["working-directory"]),
      continueOnError: raw["continue-on-error"] ?? false,
      timeoutMinutes: typeof timeout === "number" ? timeout : undefined,
    };
  });
}

function parseDefaults(v: unknown) {
  const run = isRec(v) && isRec(v.run) ? v.run : {};
  return { shell: str(run.shell), workingDirectory: str(run["working-directory"]) };
}

/** Event names from `on:` (a string, a list or a mapping). */
function triggersOf(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (isRec(on)) return Object.keys(on);
  return [];
}

export function parseWorkflow(path: string, text: string): WorkflowDef {
  const doc = parseYaml(text, path);
  const on = doc.on ?? doc.true; // YAML 1.1 parsers turn `on` into true; the yaml package (1.2) keeps "on".
  const triggers = triggersOf(on);
  const onRec = isRec(on) ? on : {};
  const callRaw = triggers.includes("workflow_call") ? (isRec(onRec.workflow_call) ? onRec.workflow_call : {}) : undefined;
  const dispatch = isRec(onRec.workflow_dispatch) ? onRec.workflow_dispatch : {};
  if (!isRec(doc.jobs)) throw new DefinitionError(`${path}: no jobs`);
  const jobs = Object.entries(doc.jobs).map(([id, raw]): JobDef => {
    if (!isRec(raw)) throw new DefinitionError(`${path}: job ${id} must be a mapping`);
    const needs = raw.needs === undefined ? [] : Array.isArray(raw.needs) ? raw.needs.map(String) : [String(raw.needs)];
    const secrets = raw.secrets === "inherit" ? "inherit" : strMap(raw.secrets);
    const timeout = raw["timeout-minutes"];
    return {
      id,
      name: str(raw.name),
      needs,
      if: raw.if,
      runsOn: raw["runs-on"],
      env: strMap(raw.env),
      outputs: strMap(raw.outputs),
      steps: parseSteps(raw.steps, `${path} job ${id}`),
      uses: str(raw.uses),
      with: isRec(raw.with) ? raw.with : {},
      secrets,
      defaults: parseDefaults(raw.defaults),
      timeoutMinutes: typeof timeout === "number" ? timeout : undefined,
      continueOnError: raw["continue-on-error"] ?? false,
      unsupportedKeys: [...JOB_UNSUPPORTED.filter((k) => k in raw), ...Object.keys(raw).filter((k) => !JOB_KNOWN.has(k))],
      ignoredKeys: JOB_IGNORED.filter((k) => k in raw),
    };
  });
  return {
    path,
    name: str(doc.name),
    triggers,
    call: callRaw
      ? {
          inputs: parseInputs(callRaw.inputs),
          outputs: Object.fromEntries(Object.entries(isRec(callRaw.outputs) ? callRaw.outputs : {}).map(([k, o]) => [k, str(isRec(o) ? o.value : o) ?? ""])),
          secrets: Object.fromEntries(Object.entries(isRec(callRaw.secrets) ? callRaw.secrets : {}).map(([k, s]) => [k, { required: isRec(s) && s.required === true }])),
        }
      : undefined,
    dispatchInputs: parseInputs(dispatch.inputs),
    env: strMap(doc.env),
    defaults: parseDefaults(doc.defaults),
    jobs,
  };
}

export function parseAction(where: string, text: string): ActionDef {
  const doc = parseYaml(text, where);
  const runs = isRec(doc.runs) ? doc.runs : {};
  const runtime = str(runs.using) ?? "";
  const using = /^node\d+$/.test(runtime) ? "node" : runtime === "composite" ? "composite" : runtime === "docker" ? "docker" : "unsupported";
  const inputs = isRec(doc.inputs)
    ? Object.fromEntries(Object.entries(doc.inputs).map(([k, s]) => [k, { required: isRec(s) && s.required === true, default: isRec(s) ? str(s.default) : undefined }]))
    : {};
  const outputs = isRec(doc.outputs) ? Object.fromEntries(Object.entries(doc.outputs).map(([k, o]) => [k, isRec(o) ? str(o.value) : undefined])) : {};
  return {
    name: str(doc.name),
    using,
    runtime,
    main: str(runs.main),
    pre: str(runs.pre),
    post: str(runs.post),
    postIf: str(runs["post-if"]),
    inputs,
    outputs,
    steps: using === "composite" ? parseSteps(runs.steps, where) : [],
  };
}

// ---- `uses:` references --------------------------------------------------------------------------------------------

export type UsesRef =
  | { kind: "local"; path: string }
  | { kind: "remote"; owner: string; repo: string; path: string; ref: string }
  | { kind: "docker"; image: string }
  | { kind: "invalid"; raw: string };

const NAME = /^[A-Za-z0-9_.-]+$/;

export function parseUses(raw: string): UsesRef {
  const s = raw.trim();
  if (s.startsWith("docker://")) return { kind: "docker", image: s.slice(9) };
  if (s.startsWith("./")) {
    const path = normalizePath(s.slice(2));
    return path === null ? { kind: "invalid", raw } : { kind: "local", path };
  }
  const at = s.lastIndexOf("@");
  if (at <= 0) return { kind: "invalid", raw };
  const [owner, repo, ...rest] = s.slice(0, at).split("/");
  const ref = s.slice(at + 1);
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo) || !ref || /\s/.test(ref)) return { kind: "invalid", raw };
  const path = normalizePath(rest.join("/"));
  return path === null ? { kind: "invalid", raw } : { kind: "remote", owner, repo, path, ref };
}

/**
 * A safe relative path: forward slashes, no empty, "." or ".." segments, no NUL or backslash. "" is the root.
 * Returns null for anything else, so no snapshot path can escape its directory.
 */
export function normalizePath(p: string): string | null {
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (trimmed.startsWith("/") || /[\\\0]/.test(trimmed)) return null;
  const parts = trimmed.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) return null;
  return parts.join("/");
}

export const isWorkflowPath = (p: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);

/** `actions/checkout`, compared case-insensitively. */
export const isCheckout = (u: UsesRef) => u.kind === "remote" && u.owner.toLowerCase() === "actions" && u.repo.toLowerCase() === "checkout" && u.path === "";
