// Step ↔ log mapping v2 (docs/ARCHITECTURE.md §8, project brief R5). Pure: no browser or worker APIs.
//
// GitHub does not publish where each step's output starts in a job log. The runner writes markers we can align
// with the API's step list:
//   - "Set up job" starts at the first line;
//   - each top-level `##[group]Run …` starts a run or action step. `Run` markers nested inside
//     `##[start-action …]` … `##[end-action …]` belong to a composite action's inner steps and are ignored;
//   - each "Post job cleanup." starts a post step; "Cleaning up orphan processes" starts "Complete job".
// Markers are matched to executed steps by kind, then order, then time window, preferring an exact name match.
//
// The result is checked with the consistency checks from experiment E4 (these are not ground truth):
//   C1 every executed step gets a segment, in order;
//   C2 the segment's first timestamp falls within the step's start/end (±1 s, API times are whole seconds);
//   C3 the opening marker is not another step's exact name;
//   C4 a failed step's segment holds `##[error]` lines or a failure signature (an exception, a compiler
//      diagnostic, … from the line classifier), and no `##[error]` line falls in a passing step;
// plus the risk flag "more top-level Run markers than executed run steps". If anything trips, the mapping is
// "approximate". A step with no matched marker has no segment: no line is attributed to it.
import type { Step } from "../types";

export type MarkerKind = "run" | "post" | "complete";
/** `line` is 0-based. `time` is epoch ms from the line's timestamp, when it has one. */
export type LogMarker = { line: number; kind: MarkerKind; text: string; time?: number; nested: boolean };
/** A line of failure evidence: `rank` from `evidenceRank` (0 strongest). `line` is 0-based. */
export type EvidenceLine = { line: number; rank: number };
export type LogMarkers = { lineCount: number; firstTime?: number; markers: LogMarker[]; errors: number[]; capped: boolean; evidence?: EvidenceLine[] };

const MAX_MARKERS = 20_000;
const MAX_ERRORS = 20_000;
const STAMP = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z /;

function parseTime(date: string, fraction: string | undefined): number {
  return Date.parse(`${date}${(fraction ?? "").slice(0, 4)}Z`);
}

/** Collects markers line by line, so the log worker can scan its store without building an array of lines. */
export function createMarkerScanner() {
  const markers: LogMarker[] = [];
  const errors: number[] = [];
  let capped = false;
  let depth = 0;
  let firstTime: number | undefined;
  let lines = 0;

  return {
    push(raw: string): void {
      const n = lines++;
      const m = STAMP.exec(raw);
      const time = m ? parseTime(m[1]!, m[2]) : undefined;
      if (n === 0) firstTime = time;
      const text = m ? raw.slice(m[0].length) : raw.replace(/^\uFEFF/, "");
      if (!text.startsWith("##[") && !text.startsWith("Post job cleanup.") && !text.startsWith("Cleaning up orphan processes")) return;
      let kind: MarkerKind | undefined;
      if (text.startsWith("##[start-action")) depth++;
      else if (text.startsWith("##[end-action")) depth = Math.max(0, depth - 1);
      else if (text.startsWith("##[error]")) {
        if (errors.length < MAX_ERRORS) errors.push(n);
        else capped = true;
      } else if (text.startsWith("##[group]Run ")) kind = "run";
      else if (text.trimEnd() === "Post job cleanup.") kind = "post";
      else if (text.trimEnd() === "Cleaning up orphan processes") kind = "complete";
      if (!kind) return;
      if (markers.length >= MAX_MARKERS) {
        capped = true;
        return;
      }
      markers.push({ line: n, kind, text: kind === "run" ? text.slice("##[group]".length).trimEnd() : text.trimEnd(), time, nested: depth > 0 });
    },
    result(lineCount = lines): LogMarkers {
      return { lineCount, firstTime, markers, errors, capped };
    },
  };
}

export type StepKind = "setup" | "run" | "post" | "complete";
export function stepKind(step: Pick<Step, "name">): StepKind {
  if (step.name === "Set up job") return "setup";
  if (step.name === "Complete job") return "complete";
  if (step.name.startsWith("Post ")) return "post";
  return "run";
}

/**
 * 1-based, inclusive line numbers, as shown in the log view. `errorLines` are `##[error]` lines; `evidence` is every
 * line of failure evidence (annotations, failure signatures, text matches), strongest first, then in log order.
 */
export type StepSegment = { stepNumber: number; startLine: number; endLine: number; marker: string; errorLines: number[]; evidence: EvidenceLine[] };

/** Ranks up to this are strong enough to confirm a failed step's boundaries (C4): annotations, signatures, test failures, exit codes. */
const CONFIRMING_RANK = 3;

export type StepMapping = {
  mapping: "exact-checks-passed" | "approximate" | "unavailable";
  segments: StepSegment[];
  /** Why the mapping is approximate or unavailable, in plain words. Empty when every check passed. */
  issues: string[];
};

export type StepLocation =
  | { kind: "segment"; segment: StepSegment; approximate: boolean; issues: string[] }
  | { kind: "no-output"; reason: "skipped" | "not-run" }
  | { kind: "unmatched"; issues: string[] };

/** A step can have log output unless it was skipped or has not run. GitHub may omit a completed step's times. */
export function hasLogOutput(s: Pick<Step, "status" | "conclusion" | "started_at">): boolean {
  return s.conclusion !== "skipped" && (s.started_at !== null || s.status === "completed");
}
const executed = hasLogOutput;
const seconds = (iso: string | null) => (iso ? Date.parse(iso) : undefined);

function inWindow(step: Step, time: number | undefined): boolean {
  if (time === undefined) return true;
  const start = seconds(step.started_at);
  const end = seconds(step.completed_at);
  // API times are whole seconds (truncated), so allow the stated ±1 s plus the truncated fraction.
  if (start !== undefined && time < start - 1000) return false;
  if (end !== undefined && time >= end + 2000) return false;
  return true;
}

/** Matches steps of one kind to markers of the same kind: order first, then time window, preferring an exact name. */
function align(steps: Step[], markers: LogMarker[]): Map<number, LogMarker> {
  const out = new Map<number, LogMarker>();
  if (steps.length === markers.length) {
    steps.forEach((s, i) => out.set(s.number, markers[i]!));
    return out;
  }
  let from = 0;
  steps.forEach((step, i) => {
    // With extra markers, leave enough for the remaining steps; with missing markers, any later one may match.
    const room = markers.length > steps.length ? markers.length - (steps.length - i - 1) : markers.length;
    const candidates = markers.slice(from, Math.max(from, room)).filter((m) => inWindow(step, m.time));
    const pick = candidates.find((m) => m.text === step.name) ?? candidates[0];
    if (pick) {
      out.set(step.number, pick);
      from = markers.indexOf(pick) + 1;
    }
  });
  return out;
}

export function mapSteps(steps: Step[], log: LogMarkers): StepMapping {
  const ran = steps.filter(executed).sort((a, b) => a.number - b.number);
  if (log.lineCount === 0) return { mapping: "unavailable", segments: [], issues: ["The log is empty."] };
  if (ran.length === 0) return { mapping: "unavailable", segments: [], issues: ["GitHub reported no executed steps for this job."] };

  const topRun = log.markers.filter((m) => m.kind === "run" && !m.nested);
  const byKind: Record<Exclude<StepKind, "setup">, LogMarker[]> = {
    run: topRun,
    post: log.markers.filter((m) => m.kind === "post"),
    complete: log.markers.filter((m) => m.kind === "complete"),
  };
  const starts = new Map<number, LogMarker>();
  const setup = ran.find((s) => stepKind(s) === "setup");
  if (setup) starts.set(setup.number, { line: 0, kind: "run", text: "(first line of the log)", time: log.firstTime, nested: false });
  for (const kind of ["run", "post", "complete"] as const) {
    for (const [n, m] of align(
      ran.filter((s) => stepKind(s) === kind),
      byKind[kind],
    ))
      starts.set(n, m);
  }

  const issues: string[] = [];
  if (log.capped) issues.push("The log has too many markers or error lines to check every boundary.");
  const runSteps = ran.filter((s) => stepKind(s) === "run").length;
  if (topRun.length > runSteps) {
    issues.push(
      `The log has ${topRun.length} top-level “Run” markers for ${runSteps} executed run step${runSteps === 1 ? "" : "s"}. A composite action or a script may have printed its own markers, or the runner did not mark composite actions.`,
    );
  }

  // C1: every executed step has a start, and starts are in step order.
  const unmatched = ran.filter((s) => !starts.has(s.number));
  if (unmatched.length) issues.push(`No log marker was found for ${unmatched.length === 1 ? "step" : "steps"} ${unmatched.map((s) => s.number).join(", ")}.`);
  const matched = ran.filter((s) => starts.has(s.number));
  for (let i = 1; i < matched.length; i++) {
    if (starts.get(matched[i]!.number)!.line <= starts.get(matched[i - 1]!.number)!.line) {
      issues.push("The log markers are not in the same order as GitHub's steps.");
      break;
    }
  }

  const ordered = [...matched].sort((a, b) => starts.get(a.number)!.line - starts.get(b.number)!.line);
  const names = new Map(ran.map((s) => [s.name, s.number]));
  const segments: StepSegment[] = ordered.map((step, i) => {
    const marker = starts.get(step.number)!;
    const startLine = marker.line + 1;
    const endLine = i + 1 < ordered.length ? starts.get(ordered[i + 1]!.number)!.line : log.lineCount;
    const errorLines = log.errors.filter((e) => e + 1 >= startLine && e + 1 <= endLine).map((e) => e + 1);
    const evidence = (log.evidence ?? [])
      .filter((e) => e.line + 1 >= startLine && e.line + 1 <= endLine)
      .map((e) => ({ line: e.line + 1, rank: e.rank }))
      .sort((a, b) => a.rank - b.rank || a.line - b.line);
    // C2
    if (!inWindow(step, marker.time)) issues.push(`Step ${step.number}'s first log line is outside the step's reported start and end times.`);
    // C3
    const owner = names.get(marker.text);
    if (owner !== undefined && owner !== step.number) issues.push(`Step ${step.number} starts at a marker named exactly like step ${owner}.`);
    // C4
    if (step.conclusion === "failure" && errorLines.length === 0 && !evidence.some((e) => e.rank <= CONFIRMING_RANK))
      issues.push(`Step ${step.number} failed, but no error line was found in its part of the log.`);
    if (step.conclusion === "success" && errorLines.length > 0) issues.push(`An error line falls in step ${step.number}, which succeeded.`);
    return { stepNumber: step.number, startLine, endLine, marker: marker.text, errorLines, evidence };
  });
  segments.sort((a, b) => a.stepNumber - b.stepNumber);

  if (segments.length === 0) return { mapping: "unavailable", segments, issues };
  return { mapping: issues.length ? "approximate" : "exact-checks-passed", segments, issues };
}

/** Where a step's output is, or why it cannot be shown. Never attributes lines to a step without a matched marker. */
export function locateStep(steps: Step[], mapping: StepMapping, stepNumber: number): StepLocation {
  const step = steps.find((s) => s.number === stepNumber);
  if (step && step.conclusion === "skipped") return { kind: "no-output", reason: "skipped" };
  if (step && !hasLogOutput(step)) return { kind: "no-output", reason: "not-run" };
  const segment = mapping.segments.find((s) => s.stepNumber === stepNumber);
  if (!segment) return { kind: "unmatched", issues: mapping.issues };
  return { kind: "segment", segment, approximate: mapping.mapping !== "exact-checks-passed", issues: mapping.issues };
}

/** The line to open: a failed step's strongest error evidence (or its first `##[error]` line), otherwise its first line. */
export function targetLine(segment: StepSegment, step: Pick<Step, "conclusion"> | undefined): number {
  if (!step || step.conclusion === "success") return segment.startLine;
  return segment.evidence[0]?.line ?? segment.errorLines[0] ?? segment.startLine;
}
