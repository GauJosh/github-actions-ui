// Queries the log worker answers over one log: a bounded search with excerpts (pipeline-wide search), and line
// fingerprints for comparing two logs. Pure: they run over any `ViewSource`; nothing here copies the log.
import { diffSequences, type DiffResult } from "../compare/diff";
import { FOLD, LINE_KINDS, kindOf, stripAnsi, stripStamp, type LineKind } from "./classify";
import { compileSearch, type SearchOptions, type ViewSource } from "./view";

export type FindMatch = { line: number; text: string; kind: LineKind; reason?: string; ranges: [number, number][] };
/** `lines`: how many lines were searched (the whole document as loaded so far). */
export type FindResult = { matches: FindMatch[]; capped: boolean; lines: number } | { error: string };

const EXCERPT = 240;

/** One excerpt of at most EXCERPT characters around the first match, with match ranges relative to it. */
function excerpt(text: string, ranges: [number, number][]): { text: string; ranges: [number, number][] } {
  if (text.length <= EXCERPT) return { text, ranges };
  const first = ranges[0] ?? [0, 0];
  const start = Math.max(0, Math.min(first[0] - 60, text.length - EXCERPT));
  const end = start + EXCERPT;
  const cut = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  const shift = start > 0 ? 1 - start : 0;
  return { text: cut, ranges: ranges.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a + shift, b + shift]) };
}

/**
 * Lines matching `search`, optionally only lines of the given kinds (e.g. errors), up to `cap`. Line numbers are
 * 0-based in this document. The source must be classified up to its complete lines.
 */
export function findLines(src: ViewSource, search: SearchOptions, kinds: LineKind[] | undefined, cap: number): FindResult {
  const matcher = compileSearch(search);
  if (matcher && "error" in matcher) return { error: matcher.error };
  const wanted = kinds?.length ? new Set(kinds.map((k) => LINE_KINDS.indexOf(k))) : null;
  const c = src.classified;
  const matches: FindMatch[] = [];
  const count = src.lineCount;
  for (let n = 0; n < count; n++) {
    const kind = n < c.count ? c.kinds[n]! : 0;
    if (wanted && !wanted.has(kind)) continue;
    const text = src.text(n);
    if (matcher && !matcher.test(text)) continue;
    if (matches.length === cap) return { matches, capped: true, lines: count };
    const ex = excerpt(text, matcher ? matcher.ranges(text) : []);
    matches.push({ line: n, text: ex.text, ranges: ex.ranges, kind: kindOf(kind) });
  }
  return { matches, capped: false, lines: count };
}

// ---- comparison ---------------------------------------------------------------------------------

const ISO = /\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g;
const CLOCK = /\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b[0-9a-f]{7,64}\b/g;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?|h)\b/g;
const TEMP = /(\/tmp\/|\\Temp\\|_temp\/)[\w.-]+/g;

/**
 * The text two logs are compared on: without the runner's timestamp, colour codes, times, ids, commit hashes,
 * durations and temporary file names, which differ between any two runs. Numbers such as counts and exit codes
 * are kept: a different exit code is a real difference.
 */
export function normalizeLine(raw: string): string {
  return stripAnsi(stripStamp(raw.endsWith("\r") ? raw.slice(0, -1) : raw))
    .replace(ISO, "<time>")
    .replace(CLOCK, "<time>")
    .replace(UUID, "<id>")
    .replace(HEX, (h) => (/\d/.test(h) && /[a-f]/.test(h) ? "<hash>" : h))
    .replace(DURATION, "<duration>")
    .replace(TEMP, "$1<tmp>")
    .trimEnd();
}

/** FNV-1a, 32 bits. */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const NOISE_KINDS = new Set(["control", "runner", "debug"].map((k) => LINE_KINDS.indexOf(k as LineKind)));
const NOISE_FOLDS = new Set<number>([FOLD.control, FOLD.setup, FOLD.cleanup, FOLD.definition]);

export type Fingerprints = { hashes: Uint32Array; lines: Uint32Array; kinds: Uint8Array };

/**
 * One fingerprint per compared line, with its 0-based line number and kind. `essential`: leave out runner setup,
 * cleanup, control markers and the echo of step scripts (they differ for reasons unrelated to the job's work).
 * `range`: [from, to) lines only (a step).
 */
export function fingerprints(src: ViewSource, essential: boolean, range?: [number, number]): Fingerprints {
  const c = src.classified;
  const from = Math.max(0, range?.[0] ?? 0);
  const to = Math.min(src.lineCount, range?.[1] ?? src.lineCount);
  const hashes = new Uint32Array(Math.max(0, to - from));
  const lines = new Uint32Array(hashes.length);
  const kinds = new Uint8Array(hashes.length);
  let k = 0;
  for (let n = from; n < to; n++) {
    const kind = n < c.count ? c.kinds[n]! : 0;
    if (essential && n < c.count && (NOISE_KINDS.has(kind) || NOISE_FOLDS.has(c.folds[n]!))) continue;
    const text = normalizeLine(src.text(n));
    if (essential && text === "") continue;
    hashes[k] = hashText(text);
    lines[k] = n;
    kinds[k] = kind;
    k++;
  }
  return { hashes: hashes.slice(0, k), lines: lines.slice(0, k), kinds: kinds.slice(0, k) };
}

export type LogDiff = { diff: DiffResult; own: Fingerprints };

/** Diffs another log's fingerprints (the baseline) against this log's (`own`). Runs in the worker that holds `own`. */
export function diffAgainst(other: Uint32Array, src: ViewSource, essential: boolean, range: [number, number] | undefined, maxEdits: number): LogDiff {
  const own = fingerprints(src, essential, range);
  return { diff: diffSequences(other, own.hashes, maxEdits), own };
}
