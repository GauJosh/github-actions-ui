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
// Everything else stays visible. Error evidence has three tiers, never merged:
//   - runner annotations (`##[error]`): explicit, written by the runner or an action;
//   - strong failure signatures: formats tools only print when something failed — a named exception with its
//     stack trace, a Node.js error code, a Python traceback's exception, an uncaught Java exception, a Go panic,
//     a compiler diagnostic, `command not found`, a failed make target, npm's error block, a test runner's failure
//     report;
//   - text matches: a line that merely starts like an error ("error: …", "ERROR …", `level=error`).
// None of them proves the job failed (a step may tolerate a failing command); GitHub's step conclusion does.
// Stack-trace lines after an exception are marked as such so they stay together and visible.
// The raw lines are never changed; classification only adds codes beside them.

export const LINE_KINDS = [
  "output", // unclassified output of a `run:` step, or anything not recognised
  "error", // `##[error]` runner annotation
  "warning", // `##[warning]` runner annotation
  "error-text", // text that looks like an error (pattern match only)
  "warning-text", // text that looks like a warning (pattern match only)
  "error-signature", // a strong failure signature: an exception, error code, compiler diagnostic, …
  "stack", // a stack-trace line belonging to an exception (frames, traceback header, cause, error properties)
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
  "advisory", // a `##[warning]` annotation that is a platform deprecation or upgrade notice, not about the job's work
] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** Why a line was classified as it was. Shown to the user on hover. */
export const REASONS = [
  "no rule matched",
  "runner annotation ##[error]",
  "runner annotation ##[error] that only reports the exit code",
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
  "failure signature: test or build tool failure report",
  "failure signature: Node.js error with an error code",
  "failure signature: named exception (…Error: / …Exception:)",
  "failure signature: error message followed by a stack trace",
  "failure signature: Python exception ending a traceback",
  "failure signature: uncaught Java exception",
  "failure signature: Go panic or fatal runtime error",
  "failure signature: compiler or linter diagnostic",
  "failure signature: shell command not found",
  "failure signature: make target failed",
  "failure signature: npm error",
  "failure signature: fatal error reported by a tool (fatal: …)",
  "stack trace: frame",
  "stack trace: Python traceback header",
  "stack trace: exception cause",
  "stack trace: error properties",
  "text pattern: starts like an error message",
  "text pattern: structured log level error",
  "text pattern: starts like a warning message",
  "text pattern: compiler or linter warning",
  "text pattern: structured log level warning",
  "output of a run: step (not classified further)",
  "failure signature: package or dependency resolution failed",
  "failure signature: build tool reported a failed build",
  "failure signature: container build or daemon error",
  "failure signature: a command exited with a non-zero code",
  "failure signature: unhandled exception",
  "failure signature: Rust panic",
  "stack trace: Go goroutine trace",
  "text pattern: workflow command printed as text (::error:: was not processed, so it is not an annotation)",
  "text pattern: workflow command printed as text (::warning:: was not processed, so it is not an annotation)",
  "runner annotation ##[warning]: platform deprecation or upgrade notice (not about this job's work)",
  "text logged by a test (console block in test output): not treated as an error",
  "mentions an expected or ignored error: not treated as one",
  "inside a runner job-setup group",
] as const;
export type Reason = (typeof REASONS)[number];

/** Fold codes: 0 = always visible in Essential output. */
export const FOLDS = ["", "runner control markers", "runner setup", "runner cleanup", "group", "step definition", "repeated line"] as const;
export const FOLD = { none: 0, control: 1, setup: 2, cleanup: 3, group: 4, definition: 5, repeat: 6 } as const;

const K = Object.fromEntries(LINE_KINDS.map((k, i) => [k, i])) as Record<LineKind, number>;
const R = Object.fromEntries(REASONS.map((r, i) => [r, i])) as Record<Reason, number>;

export const kindOf = (code: number): LineKind => LINE_KINDS[code] ?? "output";
export const reasonOf = (code: number): Reason => REASONS[code] ?? "no rule matched";
const PROBLEM = new Set<number>([K.error, K.warning, K["error-text"], K["warning-text"], K["error-signature"], K.notice, K["test-failed"]]);
export const isProblemKind = (code: number): boolean => PROBLEM.has(code);

/** Evidence tiers, strongest first. */
export const EVIDENCE = ["annotation", "signature", "test failure", "exit code", "text match"] as const;
export type EvidenceTier = (typeof EVIDENCE)[number];
const EXIT_ONLY = R["runner annotation ##[error] that only reports the exit code"];
/**
 * How strong a line is as failure evidence: 0 a specific `##[error]` annotation, 1 a failure signature, 2 a test or
 * build failure report, 3 an annotation that only reports the exit code (the cause is usually above it), 4 a text
 * match. -1: not error evidence.
 */
export function evidenceRank(kind: number, reason: number): number {
  if (kind === K.error) return reason === EXIT_ONLY ? 3 : 0;
  if (kind === K["error-signature"]) return 1;
  if (kind === K["test-failed"]) return 2;
  if (kind === K["error-text"]) return 4;
  return -1;
}

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
  [/^(?:FAILED|ERROR) [\w./-]+::\S+/, "failure signature: test or build tool failure report"], // pytest short summary
  [/^[\w./-]+::\S+ (?:FAILED|ERROR)\b/, "failure signature: test or build tool failure report"], // pytest -v
  [/^=+ .*\b\d+ (?:failed|errors?)\b.*=+$/, "failure signature: test or build tool failure report"], // pytest summary
  [/^\s*FAIL\s+\S+/, "failure signature: test or build tool failure report"], // jest file / go package
  [/^\s*--- FAIL: /, "failure signature: test or build tool failure report"], // go test
  [/^\s*(?:Tests|Test Files|Test Suites):\s+.*\b[1-9]\d* failed\b/, "failure signature: test or build tool failure report"], // jest, vitest
  [/Tests run: \d+, Failures: (?:[1-9]\d*, Errors: \d+|\d+, Errors: [1-9]\d*)/, "failure signature: test or build tool failure report"], // maven, junit
  [/\bBUILD FAIL(?:URE|ED)\b/, "failure signature: test or build tool failure report"], // maven, gradle
  [/^Failed!\s+-\s+Failed:\s+[1-9]/, "failure signature: test or build tool failure report"], // dotnet test
  [/^Found [1-9]\d* errors?\b/, "failure signature: test or build tool failure report"], // tsc
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
// Formats a tool prints when something failed. Anchored, so prose that mentions an error does not match.
const SIGNATURE: Pattern[] = [
  [/^\s*(?:Uncaught\s+)?(?:[A-Z]\w*)?Error \[[A-Z][A-Z0-9_]+\]: \S/, "failure signature: Node.js error with an error code"], // Error [ERR_MODULE_NOT_FOUND]: …
  [/^Exception in thread "[^"]*" [\w$.]+/, "failure signature: uncaught Java exception"],
  [/^\s*(?:Uncaught\s+)?(?:[\w$]+\.)*[A-Z]\w*(?:Error|Exception)(?::\s+\S|$)/, "failure signature: named exception (…Error: / …Exception:)"], // TypeError: …, java.lang.IllegalStateException: …
  [/^panic: |^fatal error: /, "failure signature: Go panic or fatal runtime error"],
  [/:\d+(?::\d+)?: (?:fatal )?error:|\berror (?:TS|CS|NU|MSB|NETSDK|FS|BC)\d+:|\berror\[E\d+\]|^\s+\d+:\d+\s+error\s+\S/, "failure signature: compiler or linter diagnostic"],
  [/^(?:\S+: )?(?:line \d+: )?\S+: command not found$/, "failure signature: shell command not found"],
  [/^make(?:\[\d+\])?: \*\*\* .*(?:Error \d+|Stop\.)$/, "failure signature: make target failed"],
  [/^npm (?:ERR!|error) /, "failure signature: npm error"],
  [/^fatal: \S/, "failure signature: fatal error reported by a tool (fatal: …)"],
  [
    /^\s*ERR_PNPM_[A-Z_]+\b|^error (?:Couldn't find package|An unexpected error occurred|Command failed with exit code \d+)|^ERROR: (?:Could not find a version that satisfies|No matching distribution found|Could not install packages|Failed building wheel|ResolutionImpossible|Cannot install)|Could not resolve dependencies for project|^Could not resolve all (?:files|dependencies|artifacts) for configuration|^go: .*(?:: not found|cannot find module providing package|missing go\.sum entry|checksum mismatch)/,
    "failure signature: package or dependency resolution failed",
  ],
  [/^\[ERROR\] Failed to execute goal |^FAILURE: Build failed with an exception\.|^\* What went wrong:$|^error: could not compile `/, "failure signature: build tool reported a failed build"],
  [/^(?:ERROR: |#\d+ ERROR: )?failed to solve: |^Error response from daemon: /, "failure signature: container build or daemon error"],
  [/^Unhandled [Ee]xception[.:] \S/, "failure signature: unhandled exception"],
  [/^thread '[^']*' panicked at /, "failure signature: Rust panic"],
  [
    /^(?:Error: )?The process '[^']+' failed with exit code [1-9]\d*|\breturned non-zero exit status [1-9]\d*|\bexited with (?:exit )?code [1-9]\d*\b/,
    "failure signature: a command exited with a non-zero code",
  ],
];
const ERROR_TEXT: Pattern[] = [
  [/^\s*(?:error|ERROR|Error)(?:\s*\[[\w-]+\])?(?:\s*:|!)/, "text pattern: starts like an error message"],
  [/^\s*(?:FATAL|Fatal)(?:\s*:|!)/, "text pattern: starts like an error message"],
  [/^\[ERROR\] /, "text pattern: starts like an error message"],
  [/\blevel=(?:error|fatal)\b|"level"\s*:\s*"(?:error|fatal)"/, "text pattern: structured log level error"],
];
// Stack traces. A frame line only counts after an exception or another frame, or as the start of one.
const FRAME = /^\s+at (?:async )?\S.*(?:\)|:\d+(?::\d+)?| in \S+:line \d+)\s*\{?$|^\s+\.\.\. \d+ (?:more|common frames omitted)$|^\s+from \S+:\d+:in [`'].*'$/;
const CAUSE = /^\s*(?:Caused by: |\[cause\]: )\S/;
const TRACEBACK = /^\s*Traceback \(most recent call last\):$/;
/** A line that an immediately following stack trace confirms as an exception message. */
const EXCEPTION_LIKE = /^\s*(?:Uncaught\s+)?[\w$.]*(?:Error|Exception)\b/;
const MAX_TRACE_LOOKBACK = 10;
// Go: "goroutine 1 [running]:" then pairs of "pkg.Func(args)" and "\t/path/file.go:12 +0x1d".
const GOROUTINE = /^goroutine \d+ \[[^\]]+\]:$/;
const GO_FRAME = /^\t\S+\.go:\d+(?: \+0x[0-9a-f]+)?$|^(?:created by )?[\w./*()-]+\.[\w*()-]+\(.*\)(?: in goroutine \d+)?$/;
/** A `##[warning]` about the platform rather than the job: deprecations and runner upgrades. */
const ADVISORY =
  /Node\.js \d+ actions are deprecated|The following actions (?:use|are running on) (?:a )?(?:deprecated )?Node\.js|The `(?:set-output|save-state|set-env|add-path)` command is deprecated|(?:is|are) deprecated and will be (?:removed|disabled)|ubuntu-latest (?:pipelines|label) will (?:use|be)/i;
/** Prose that names an error as expected or ignored (tests, scripts that tolerate a failure). */
const EXPECTED = /\bexpected (?:an? )?(?:error|failure|exception)\b|\((?:expected|ignored|allowed to fail)\)\s*$|\bignoring (?:the )?(?:error|failure)\b|\bcontinuing anyway\b|\berror is expected\b/i;
/** A test runner's console block header (Jest prints the logged text indented below it). */
const CONSOLE_BLOCK = /^(\s*)console\.(?:error|warn|log|info|debug)$/;
const LOGGED_BY_TEST: Reason = "text logged by a test (console block in test output): not treated as an error";
const MAX_PROPS = 100;
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
  private trace: "none" | "python" | "frames" | "props" | "go" = "none";
  /** Inside a test runner's console block: the header's indent, or -1. */
  private consoleIndent = -1;
  private propsLines = 0;
  /** The last line that a following stack trace would confirm as an exception message, or -1. */
  private candidate = -1;

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
    if (kind !== "stack" && (kind === "error-text" || EXCEPTION_LIKE.test(text))) this.candidate = n;
    if (this.group && n > this.group.start) {
      if (isProblemKind(K[kind]) || kind === "stack") this.group.problem = true;
      else if (this.group.run ? kind === "script" || kind === "settings" : fold === FOLD.none) this.group.pending.push(n);
    }
    this.repeat(n, text, kind);
  }

  private classify(n: number, text: string, coloured: string): [LineKind, Reason, number] {
    if (text.startsWith("##[")) {
      const marker = this.marker(n, text);
      if (marker) {
        this.trace = "none";
        this.consoleIndent = -1;
        return marker;
      }
    }
    const g = this.group;
    if (g?.run && g.echo !== "none") {
      const echo = this.echo(g, text, coloured);
      if (echo) return echo;
    }
    const quoted = this.consoleBlock(text);
    if (quoted) return quoted;
    const traced = this.stackTrace(n, text);
    if (traced) return traced;
    // Output inside a job-setup group (runner image, permissions, environment) is the runner's, whatever it says.
    if (g?.setup) return ["runner", "inside a runner job-setup group", FOLD.none];
    if (/^::error(?:\s[^:]*)?::/.test(text)) return ["error-text", "text pattern: workflow command printed as text (::error:: was not processed, so it is not an annotation)", FOLD.none];
    if (/^::warning(?:\s[^:]*)?::/.test(text)) return ["warning-text", "text pattern: workflow command printed as text (::warning:: was not processed, so it is not an annotation)", FOLD.none];
    if (EXPECTED.test(text)) return [this.usesStep ? "action-output" : "output", "mentions an expected or ignored error: not treated as one", FOLD.none];
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
    reason = first(SIGNATURE, text);
    if (reason) return ["error-signature", reason, FOLD.none];
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
    if (text.startsWith("##[error]")) return ["error", /^##\[error\]Process completed with exit code \d+\.?\s*$/.test(text) ? "runner annotation ##[error] that only reports the exit code" : "runner annotation ##[error]", FOLD.none];
    if (text.startsWith("##[warning]")) {
      return ADVISORY.test(text)
        ? ["advisory", "runner annotation ##[warning]: platform deprecation or upgrade notice (not about this job's work)", FOLD.none]
        : ["warning", "runner annotation ##[warning]", FOLD.none];
    }
    if (text.startsWith("##[notice]")) return ["notice", "runner annotation ##[notice]", FOLD.none];
    if (text.startsWith("##[debug]")) return ["debug", "runner message ##[debug]", FOLD.none];
    if (text.startsWith("##[command]")) return ["command", "command echoed by an action ([command] prefix)", FOLD.none];
    if (/^##\[(?:start-action|end-action|add-matcher|remove-matcher)\b/.test(text)) return ["control", "runner control marker", FOLD.control];
    return undefined;
  }

  /** Lines a test runner prints under `console.error` (etc.): text the test logged, not an error of the job. */
  private consoleBlock(text: string): [LineKind, Reason, number] | undefined {
    const header = CONSOLE_BLOCK.exec(text);
    if (header) {
      this.consoleIndent = header[1]!.length;
      return ["output", LOGGED_BY_TEST, FOLD.none];
    }
    if (this.consoleIndent < 0) return undefined;
    const indent = /^\s*/.exec(text)![0].length;
    if (text.trim() === "" || indent > this.consoleIndent) return ["output", LOGGED_BY_TEST, FOLD.none];
    this.consoleIndent = -1;
    return undefined;
  }

  /** Stack-trace lines: a Python traceback up to its exception line, JS/JVM/.NET/Ruby frames, causes, error properties, or a Go goroutine trace. */
  private stackTrace(n: number, text: string): [LineKind, Reason, number] | undefined {
    if (this.trace === "go") {
      if (text === "" || GO_FRAME.test(text) || GOROUTINE.test(text)) return ["stack", "stack trace: Go goroutine trace", FOLD.none];
      this.trace = "none";
    }
    if (GOROUTINE.test(text)) {
      this.trace = "go";
      return ["stack", "stack trace: Go goroutine trace", FOLD.none];
    }
    if (this.trace === "python") {
      if (/^\s/.test(text)) return ["stack", "stack trace: frame", FOLD.none];
      if (text === "") return undefined;
      this.trace = "none";
      return ["error-signature", "failure signature: Python exception ending a traceback", FOLD.none];
    }
    if (this.trace === "props") {
      if (++this.propsLines <= MAX_PROPS) {
        if (/^\s*\}\s*$/.test(text)) this.trace = "none";
        return ["stack", "stack trace: error properties", FOLD.none];
      }
      this.trace = "none";
    }
    if (TRACEBACK.test(text)) {
      this.trace = "python";
      return ["stack", "stack trace: Python traceback header", FOLD.none];
    }
    if (FRAME.test(text)) {
      if (this.trace !== "frames") this.confirmException(n);
      this.trace = text.trimEnd().endsWith("{") ? "props" : "frames";
      this.propsLines = 0;
      return ["stack", "stack trace: frame", FOLD.none];
    }
    if (this.trace === "frames" && CAUSE.test(text)) return ["stack", "stack trace: exception cause", FOLD.none];
    this.trace = "none";
    return undefined;
  }

  /** A stack trace starts: the error message just above it (within a few lines) is an exception, not just text. */
  private confirmException(n: number): void {
    const p = this.candidate;
    this.candidate = -1;
    if (p < 0 || n - p > MAX_TRACE_LOOKBACK) return;
    const old = this.kinds[p]!;
    if (old !== K["error-text"] && old !== K.output && old !== K["action-output"]) return;
    this.counts[old]!--;
    this.kinds[p] = K["error-signature"];
    this.reasons[p] = R["failure signature: error message followed by a stack trace"];
    this.counts[K["error-signature"]]!++;
    this.folds[p] = FOLD.none;
    if (this.group && p > this.group.start) this.group.problem = true;
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
