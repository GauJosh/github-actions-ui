// Conservative classification of job-log lines (docs/ARCHITECTURE.md §8.1). Pure: no browser or worker APIs.
//
// One pass, line by line, in log order. Each line gets a kind (what it is), a reason (why we think so) and a fold
// code (whether Essential output may fold it, and why). Rules, in order of confidence:
//   1. Runner control markers (`##[endgroup]`, `##[start-action …]`, matcher commands) are never output: fold.
//   2. Runner annotations (`##[error]`, `##[warning]`, `##[notice]`) are explicit: never fold.
//   3. `##[group]` sections fold like GitHub's own log viewer folds them (header visible, body folded), but only once
//      `##[endgroup]` closes them, and never when they contain an error or warning. Job-setup groups fold whole. The runner's echo of a `run:` step's script and its
//      `shell:`, `with:` and `env:` lines (inside the step's `##[group]Run …`) fold as "step definition".
//   4. A short list of exact runner lifecycle messages (job setup before the first step, orphan-process cleanup) fold.
//   5. Three or more consecutive identical lines fold to the first one.
// Everything else stays visible. Test/build results and error- or warning-looking text are recognised by anchored
// patterns, labelled as text matches: a match does not prove that a command or the job failed.
// The raw lines are never changed; classification only adds codes beside them.

export const LINE_KINDS = [
  "output", // unclassified output of a `run:` step, or anything not recognised
  "error", // `##[error]` runner annotation
  "warning", // `##[warning]` runner annotation
  "error-text", // text that looks like an error (pattern match only)
  "warning-text", // text that looks like a warning (pattern match only)
  "notice", // `##[notice]` runner annotation
  "debug", // `##[debug]` runner message
  "command", // a step's `Run …` header, or a command an action echoed with `[command]`
  "script", // the runner's echo of a `run:` step's script
  "settings", // the runner's echo of `shell:`, `with:` and `env:`
  "test", // a test or build result line
  "test-failed", // a test or build result line reporting failures
  "action-output", // output of a `uses:` step (an action)
  "section", // a `##[group]` header that is not a step header
  "runner", // a runner lifecycle message
  "control", // a runner control marker
] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** Why a line was classified as it was. Shown to the user on hover. */
export const REASONS = [
  "no rule matched",
  "runner annotation ##[error]",
  "runner annotation ##[warning]",
  "runner annotation ##[notice]",
  "runner message ##[debug]",
  "runner control marker",
  "step header written by the runner (##[group]Run …)",
  "command echoed by an action ([command] prefix)",
  "runner's echo of the step's script (written in the runner's highlight colour)",
  "runner's echo of the step's shell, inputs or environment",
  "group header (##[group])",
  "runner job-setup message",
  "runner cleanup message",
  "output of an action (uses:) step",
  "output of a post-job (action cleanup) step",
  "output during job setup",
  "text pattern: test or build result",
  "text pattern: test or build failure",
  "text pattern: starts like an error message",
  "text pattern: compiler or linter error",
  "text pattern: exception or stack trace",
  "text pattern: structured log level error",
  "text pattern: starts like a warning message",
  "text pattern: compiler or linter warning",
  "text pattern: structured log level warning",
  "output of a run: step (not classified further)",
] as const;
export type Reason = (typeof REASONS)[number];

/** Fold codes: 0 = always visible in Essential output. */
export const FOLDS = ["", "runner control markers", "runner setup", "runner cleanup", "group", "step definition", "repeated line"] as const;
export const FOLD = { none: 0, control: 1, setup: 2, cleanup: 3, group: 4, definition: 5, repeat: 6 } as const;

const K = Object.fromEntries(LINE_KINDS.map((k, i) => [k, i])) as Record<LineKind, number>;
const R = Object.fromEntries(REASONS.map((r, i) => [r, i])) as Record<Reason, number>;

export const kindOf = (code: number): LineKind => LINE_KINDS[code] ?? "output";
export const reasonOf = (code: number): Reason => REASONS[code] ?? "no rule matched";
const PROBLEM = new Set<number>([K.error, K.warning, K["error-text"], K["warning-text"], K.notice, K["test-failed"]]);
export const isProblemKind = (code: number): boolean => PROBLEM.has(code);

/** A `##[group]` … `##[endgroup]` section. Lines are 0-based; `end` is the `##[endgroup]` line. */
export type LogGroup = { start: number; end: number; name: string };

const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");
const SCRIPT_ECHO = String.fromCharCode(27) + "[36;1m";

/** Removes the runner timestamp (and a leading byte-order mark). */
export function stripStamp(raw: string): string {
  const m = STAMP.exec(raw);
  return m ? raw.slice(m[0].length) : raw.replace(/^\uFEFF/, "");
}
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

// Exact runner messages. Only these fold as lifecycle lines; similar-looking text does not.
const SETUP: RegExp[] = [
  /^Current runner version: '[^']*'$/,
  /^Runner name: '[^']*'$/,
  /^Runner group name: '[^']*'$/,
  /^Machine name: '[^']*'$/,
  /^Secret source: \w+$/,
  /^Cache mode: \w+$/,
  /^Prepare workflow directory$/,
  /^Prepare all required actions$/,
  /^Getting action download info$/,
  /^Download action repository '[^']+' \(SHA:[0-9a-f]+\)$/,
  /^Download immutable action package '[^']+'/,
  /^Complete job name: /,
  /^Waiting for a runner to pick up this job\.\.\.$/,
  /^Job is about to start running on the (?:hosted )?runner: /,
];
const CLEANUP: RegExp[] = [
  /^Cleaning up orphan processes$/,
  /^Terminate orphan process: pid \(\d+\) \(.*\)$/,
  /^Evaluate and set job outputs$/,
  /^Evaluate and set environment url$/,
  /^Uploading runner diagnostic logs$/,
];
const USES_HEADER = /^Run (?:[\w.-]+\/[\w./-]+@\S+|\.\/\S+|docker:\/\/\S+)$/;

type Pattern = [RegExp, Reason];
const TEST_FAILED: Pattern[] = [
  [/^(?:FAILED|ERROR) [\w./-]+::\S+/, "text pattern: test or build failure"], // pytest short summary
  [/^[\w./-]+::\S+ (?:FAILED|ERROR)\b/, "text pattern: test or build failure"], // pytest -v
  [/^=+ .*\b\d+ (?:failed|errors?)\b.*=+$/, "text pattern: test or build failure"], // pytest summary
  [/^\s*FAIL\s+\S+/, "text pattern: test or build failure"], // jest file / go package
  [/^\s*--- FAIL: /, "text pattern: test or build failure"], // go test
  [/^\s*(?:Tests|Test Files|Test Suites):\s+.*\b[1-9]\d* failed\b/, "text pattern: test or build failure"], // jest, vitest
  [/Tests run: \d+, Failures: (?:[1-9]\d*, Errors: \d+|\d+, Errors: [1-9]\d*)/, "text pattern: test or build failure"], // maven, junit
  [/\bBUILD FAIL(?:URE|ED)\b/, "text pattern: test or build failure"], // maven, gradle
  [/^Failed!\s+-\s+Failed:\s+[1-9]/, "text pattern: test or build failure"], // dotnet test
  [/^Found [1-9]\d* errors?\b/, "text pattern: test or build failure"], // tsc
];
const TEST: Pattern[] = [
  [/^[\w./-]+::\S+ (?:PASSED|SKIPPED|XFAIL|XPASS)\b/, "text pattern: test or build result"],
  [/^=+ .*\b\d+ (?:passed|skipped|deselected)\b.* in [\d.]+s.*=+$/, "text pattern: test or build result"],
  [/^collected \d+ items?\b|^collecting \.\.\. collected \d+ items?/, "text pattern: test or build result"],
  [/^\s*PASS\s+\S+/, "text pattern: test or build result"],
  [/^\s*--- (?:PASS|SKIP): /, "text pattern: test or build result"],
  [/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/, "text pattern: test or build result"],
  [/^\s*(?:Tests|Test Files|Test Suites):\s+.*\b\d+ (?:passed|total)\b/, "text pattern: test or build result"],
  [/Tests run: \d+, Failures: 0, Errors: 0/, "text pattern: test or build result"],
  [/\bBUILD SUCCE(?:SS|SSFUL)\b/, "text pattern: test or build result"],
  [/^Passed!\s+-\s+Failed:\s+0/, "text pattern: test or build result"],
  [/^\s*[✓✔] /, "text pattern: test or build result"],
];
const ERROR_TEXT: Pattern[] = [
  [/^\s*(?:error|ERROR|Error)(?:\[[\w-]+\])?(?:\s*:|!)/, "text pattern: starts like an error message"],
  [/^\s*(?:fatal|FATAL)(?:\s*:|!)/, "text pattern: starts like an error message"],
  [/^npm ERR! |^\[ERROR\] /, "text pattern: starts like an error message"],
  [/:\d+(?::\d+)?: (?:fatal )?error:|\berror (?:TS|CS)\d+:|\berror\[E\d+\]/, "text pattern: compiler or linter error"],
  [/^\s*Traceback \(most recent call last\):|^\s*(?:[\w$]+\.)*[A-Z]\w*(?:Error|Exception)(?::\s|$)|^panic: /, "text pattern: exception or stack trace"],
  [/\blevel=(?:error|fatal)\b|"level"\s*:\s*"(?:error|fatal)"/, "text pattern: structured log level error"],
];
const WARNING_TEXT: Pattern[] = [
  [/^\s*(?:warning|WARNING|Warning|WARN)(?:\[[\w-]+\])?(?:\s*:|!)/, "text pattern: starts like a warning message"],
  [/^npm WARN |^\[WARNING\] /, "text pattern: starts like a warning message"],
  [/:\d+(?::\d+)?: warning:|\bwarning (?:TS|CS)\d+:/, "text pattern: compiler or linter warning"],
  [/\blevel=warn(?:ing)?\b|"level"\s*:\s*"warn(?:ing)?"/, "text pattern: structured log level warning"],
];
const first = (patterns: Pattern[], text: string): Reason | undefined => patterns.find(([re]) => re.test(text))?.[1];

type OpenGroup = {
  start: number;
  name: string;
  /** A step header (`##[group]Run …`): its body is the runner's echo of the step definition. */
  run: boolean;
  /** Opened during job setup, before the first step: written by the runner. */
  setup: boolean;
  /** Echo parsing state inside a step header group. */
  echo: "script" | "meta" | "block" | "none";
  /** Body lines folded when the group closes. */
  pending: number[];
  problem: boolean;
};

/** Growable per-line arrays plus the classification state machine. */
export class LineClassifier {
  kinds = new Uint8Array(4096);
  reasons = new Uint8Array(4096);
  folds = new Uint8Array(4096);
  readonly groups: LogGroup[] = [];
  /** Lines (0-based) of `Run …` step headers at any depth, for "in step" context. */
  readonly headers: number[] = [];
  /** Lines per kind, over the lines classified so far. */
  readonly counts = new Array<number>(LINE_KINDS.length).fill(0);
  count = 0;
  /** Lines that looked malformed (an unclosed group, an unmatched end marker). Informational. */
  malformed = 0;

  private group: OpenGroup | null = null;
  private stepSeen = false;
  private usesStep = false;
  private postStep = false;
  private completeStep = false;
  private prevText: string | null = null;
  private runLength = 0;

  push(raw: string): void {
    const n = this.count++;
    this.grow(n);
    const coloured = stripStamp(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    const text = stripAnsi(coloured);
    const [kind, reason, fold] = this.classify(n, text, coloured);
    this.kinds[n] = K[kind];
    this.reasons[n] = R[reason];
    this.folds[n] = fold;
    this.counts[K[kind]]!++;
    if (this.group && n > this.group.start) {
      if (isProblemKind(K[kind])) this.group.problem = true;
      else if (this.group.run ? kind === "script" || kind === "settings" : fold === FOLD.none) this.group.pending.push(n);
    }
    this.repeat(n, text, kind);
  }

  private classify(n: number, text: string, coloured: string): [LineKind, Reason, number] {
    if (text.startsWith("##[")) {
      const marker = this.marker(n, text);
      if (marker) return marker;
    }
    const g = this.group;
    if (g?.run && g.echo !== "none") {
      const echo = this.echo(g, text, coloured);
      if (echo) return echo;
    }
    if (!g) {
      if (text === "Post job cleanup.") {
        this.postStep = true;
        this.usesStep = false;
        return ["runner", "runner cleanup message", FOLD.none];
      }
      if (!this.stepSeen && SETUP.some((re) => re.test(text))) return ["runner", "runner job-setup message", FOLD.setup];
      if (CLEANUP.some((re) => re.test(text))) {
        if (text === "Cleaning up orphan processes") this.completeStep = true;
        return ["runner", "runner cleanup message", FOLD.cleanup];
      }
    }
    if (text.startsWith("[command]")) return ["command", "command echoed by an action ([command] prefix)", FOLD.none];
    let reason = first(TEST_FAILED, text);
    if (reason) return ["test-failed", reason, FOLD.none];
    reason = first(TEST, text);
    if (reason) return ["test", reason, FOLD.none];
    reason = first(ERROR_TEXT, text);
    if (reason) return ["error-text", reason, FOLD.none];
    reason = first(WARNING_TEXT, text);
    if (reason) return ["warning-text", reason, FOLD.none];
    // Groups during job setup (runner image, permissions) are written by the runner itself.
    if (!this.stepSeen) return g ? ["runner", "runner job-setup message", FOLD.none] : ["output", "output during job setup", FOLD.none];
    if (this.completeStep) return ["output", "no rule matched", FOLD.none];
    if (this.postStep) return ["action-output", "output of a post-job (action cleanup) step", FOLD.none];
    if (this.usesStep) return ["action-output", "output of an action (uses:) step", FOLD.none];
    return ["output", "output of a run: step (not classified further)", FOLD.none];
  }

  private marker(n: number, text: string): [LineKind, Reason, number] | undefined {
    if (text.startsWith("##[group]")) {
      const name = text.slice("##[group]".length).trimEnd();
      if (this.group) this.abandonGroup();
      const run = name.startsWith("Run ");
      this.group = { start: n, name, run, setup: !this.stepSeen && !run, echo: run ? "script" : "none", pending: [], problem: false };
      if (run) {
        this.headers.push(n);
        this.stepSeen = true;
        this.postStep = false;
        // Settled once the echo shows a script (a `run:` step) or not (an action).
        this.usesStep = USES_HEADER.test(name);
        return ["command", "step header written by the runner (##[group]Run …)", FOLD.none];
      }
      return ["section", "group header (##[group])", FOLD.none];
    }
    if (text.startsWith("##[endgroup]")) {
      if (this.group) this.closeGroup(n);
      else this.malformed++;
      return ["control", "runner control marker", FOLD.control];
    }
    if (text.startsWith("##[error]")) return ["error", "runner annotation ##[error]", FOLD.none];
    if (text.startsWith("##[warning]")) return ["warning", "runner annotation ##[warning]", FOLD.none];
    if (text.startsWith("##[notice]")) return ["notice", "runner annotation ##[notice]", FOLD.none];
    if (text.startsWith("##[debug]")) return ["debug", "runner message ##[debug]", FOLD.none];
    if (text.startsWith("##[command]")) return ["command", "command echoed by an action ([command] prefix)", FOLD.none];
    if (/^##\[(?:start-action|end-action|add-matcher|remove-matcher)\b/.test(text)) return ["control", "runner control marker", FOLD.control];
    return undefined;
  }

  /** The runner's echo inside `##[group]Run …`: script lines (in its highlight colour), then shell/with/env. */
  private echo(g: OpenGroup, text: string, coloured: string): [LineKind, Reason, number] | undefined {
    const settings: [LineKind, Reason, number] = ["settings", "runner's echo of the step's shell, inputs or environment", FOLD.none];
    if (g.echo === "script" && coloured.startsWith(SCRIPT_ECHO)) {
      this.usesStep = false;
      return ["script", "runner's echo of the step's script (written in the runner's highlight colour)", FOLD.none];
    }
    if (text.startsWith("shell: ")) {
      g.echo = "meta";
      return settings;
    }
    if (text === "with:" || text === "env:") {
      g.echo = "block";
      return settings;
    }
    if (g.echo === "block" && text.startsWith("  ")) return settings;
    // Anything else means this group is not a plain echo: classify it normally and stop treating it as one.
    g.echo = "none";
    return undefined;
  }

  private closeGroup(end: number): void {
    const g = this.group!;
    this.group = null;
    this.groups.push({ start: g.start, end, name: g.name });
    if (g.problem) return;
    const code = g.run ? FOLD.definition : FOLD.group;
    for (const line of g.pending) this.folds[line] = code;
    // A group inside a step keeps its header visible, like GitHub's viewer; job-setup groups fold whole.
    if (g.setup) this.folds[g.start] = FOLD.group;
  }

  /** A new group started before `##[endgroup]`: the open one is left unfolded. */
  private abandonGroup(): void {
    this.malformed++;
    this.group = null;
  }

  private repeat(n: number, text: string, kind: LineKind): void {
    const foldable = kind === "output" || kind === "action-output" || kind === "debug";
    if (foldable && text === this.prevText) {
      this.runLength++;
      if (this.runLength === 3) {
        if (this.folds[n - 1] === FOLD.none) this.folds[n - 1] = FOLD.repeat;
      }
      if (this.runLength >= 3 && this.folds[n] === FOLD.none) this.folds[n] = FOLD.repeat;
    } else {
      this.runLength = foldable ? 1 : 0;
      this.prevText = foldable ? text : null;
    }
  }

  private grow(n: number): void {
    if (n < this.kinds.length) return;
    const size = this.kinds.length * 2;
    for (const key of ["kinds", "reasons", "folds"] as const) {
      const grown = new Uint8Array(size);
      grown.set(this[key]);
      this[key] = grown;
    }
  }
}

/** Classifies a whole log given as lines (for tests and small inputs). */
export function classifyLines(lines: string[]): LineClassifier {
  const c = new LineClassifier();
  for (const line of lines) c.push(line);
  return c;
}
