// Log display modes, quick filters and search over classified lines (docs/ARCHITECTURE.md §8.1). Pure.
//
// A view is a list of rows: each row is one original line, or one folded range of original lines that the user can
// expand. Line numbers stay the original ones. Nothing is removed from the log; a view only decides what is shown.
import { EVIDENCE, FOLD, FOLDS, LINE_KINDS, evidenceRank, kindOf, reasonOf, type EvidenceTier, type LineClassifier, type LineKind } from "./classify";

export type LogMode = "essential" | "all" | "problems";

export const FILTERS = {
  errors: { label: "Errors", kinds: ["error", "error-signature", "test-failed", "error-text"] },
  warnings: { label: "Warnings", kinds: ["warning", "warning-text"] },
  commands: { label: "Commands", kinds: ["command", "script"] },
  tests: { label: "Test/build results", kinds: ["test", "test-failed"] },
  actions: { label: "Action output", kinds: ["action-output"] },
  settings: { label: "Inputs & environment", kinds: ["settings"] },
  runner: { label: "Runner messages", kinds: ["runner", "control", "section", "notice", "debug", "advisory"] },
  unclassified: { label: "Unclassified", kinds: ["output"] },
} as const satisfies Record<string, { label: string; kinds: readonly LineKind[] }>;
export type FilterKey = keyof typeof FILTERS;
export const FILTER_KEYS = Object.keys(FILTERS) as FilterKey[];

export type SearchOptions = { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean };
export type SearchSpec = SearchOptions & {
  /** 0-based inclusive line range to search (the selected step), or the whole log. */
  scope?: [number, number];
  /** Show only matching lines (with context) instead of the mode's lines. */
  only: boolean;
};

/** A job step located in the log. Lines are 0-based and inclusive. */
export type StepSpec = { number: number; start: number; end: number; collapsed: boolean };

export type ViewSpec = {
  mode: LogMode;
  /** 0-based inclusive lines the view, counts, filters and failure navigation cover (the selected step). */
  scope?: [number, number];
  /**
   * The job's steps, in log order, when they were located. Essential output then shows a heading row per step, and
   * a collapsed step shows only its heading.
   */
  steps?: StepSpec[];
  filters: FilterKey[];
  /** Lines shown before and after each error, filtered line or match. */
  context: number;
  /** 0-based inclusive ranges the user expanded. */
  expanded: [number, number][];
  /** 0-based lines that must be visible (the target line, the current match). */
  reveal: number[];
  search?: SearchSpec;
};

/** What the view shows. Lines are 0-based. */
export type ViewSummary = {
  version: number;
  rowCount: number;
  lineCount: number;
  visibleLines: number;
  folds: number;
  matches: number[];
  matchesCapped: boolean;
  searchError?: string;
  /** Set when a regular-expression search hit its time budget; lines after this one were not searched. */
  searchStoppedAt?: number;
  /** Lines per filter, and per kind, over the lines classified so far in scope. */
  counts: Record<FilterKey, number>;
  kindCounts: Record<LineKind, number>;
  /** Error evidence in scope, per tier. */
  tiers: Tiers;
  /** Every line of error evidence in scope, in log order (for previous/next navigation). */
  errorLines: number[];
  /** The strongest error evidence in scope. */
  topEvidence: Evidence[];
  /** Per located step: its error evidence and strongest lines. */
  steps: StepSummary[];
  /** Indexes of the step heading rows, ascending (they are taller than line rows). */
  stepRows: number[];
  /** Row index of each `reveal` line. */
  revealRows: number[];
};

/** Lines of error evidence by tier; `warnings` counts annotations and text matches. */
export type Tiers = { annotations: number; signatures: number; text: number; warnings: number };
export type Evidence = { n: number; text: string; kind: LineKind; reason: string; rank: number; tier: EvidenceTier };
export type StepSummary = { number: number; start: number; end: number; tiers: Tiers; evidence: Evidence[] };

export type ViewRow =
  | { t: "line"; n: number; text: string; kind: LineKind; reason: string }
  | { t: "fold"; start: number; end: number; label: string; kind: "fold" | "gap" | "outside" }
  | {
      t: "step";
      number: number;
      start: number;
      end: number;
      collapsed: boolean;
      /** Lines shown while expanded (Essential output). */
      shown: number;
      tiers: Tiers;
      /** For a collapsed step: its last result or output line, as a hint of what it did. */
      preview?: { n: number; text: string };
    };

/** What the view needs from the log store. */
export interface ViewSource {
  /** Lines available. */
  readonly lineCount: number;
  /** Lines whose text is final (the last line may still be growing while loading). */
  readonly completeLines: number;
  readonly classified: LineClassifier;
  /** Display text of a line (ANSI escapes removed). */
  text(n: number): string;
}

export const MAX_MATCHES = 10_000;
const SEARCH_BUDGET_MS = 4_000;

// ---- search -------------------------------------------------------------------------------------

export type Matcher = { test(text: string): boolean; ranges(text: string): [number, number][] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Builds a matcher, or explains why the expression is invalid. Null for an empty query. */
export function compileSearch(o: SearchOptions): Matcher | { error: string } | null {
  if (!o.query) return null;
  if (!o.regex && !o.wholeWord) {
    const needle = o.caseSensitive ? o.query : o.query.toLowerCase();
    const fold = (t: string) => (o.caseSensitive ? t : t.toLowerCase());
    return {
      test: (t) => fold(t).includes(needle),
      ranges: (t) => {
        const out: [number, number][] = [];
        const hay = fold(t);
        for (let i = hay.indexOf(needle); i !== -1 && out.length < 100; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
        return out;
      },
    };
  }
  let source = o.regex ? o.query : escape(o.query);
  if (o.wholeWord) source = `(?<![\\w])(?:${source})(?![\\w])`;
  let re: RegExp;
  try {
    re = new RegExp(source, o.caseSensitive ? "g" : "gi");
  } catch (e) {
    return { error: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : "invalid expression" };
  }
  return {
    test: (t) => {
      re.lastIndex = 0;
      return re.test(t);
    },
    ranges: (t) => {
      const out: [number, number][] = [];
      re.lastIndex = 0;
      for (let m = re.exec(t); m && out.length < 100; m = re.exec(t)) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        out.push([m.index, m.index + m[0].length]);
      }
      return out;
    },
  };
}

type SearchCache = { key: string; upTo: number; matches: number[]; capped: boolean };

type SearchRun = { cache: SearchCache; matches: number[]; capped: boolean; stoppedAt?: number };

function runSearch(src: ViewSource, spec: SearchSpec, matcher: Matcher, cache: SearchCache | null): SearchRun {
  const key = JSON.stringify([spec.query, spec.caseSensitive, spec.wholeWord, spec.regex, spec.scope]);
  const [lo, hi] = spec.scope ?? [0, Number.MAX_SAFE_INTEGER];
  const end = Math.min(src.lineCount, hi + 1);
  const stable = Math.min(src.completeLines, end);
  // Lines already searched with the same query are not searched again while the log keeps loading.
  const reuse = cache && cache.key === key && cache.upTo <= stable ? cache : null;
  const matches = reuse ? reuse.matches.slice() : [];
  let capped = reuse?.capped ?? false;
  let stoppedAt: number | undefined;
  const t0 = Date.now();
  let n = reuse ? reuse.upTo : lo;
  let upTo = stable;
  for (; n < end && !capped; n++) {
    if (spec.regex && (n & 2047) === 0 && Date.now() - t0 > SEARCH_BUDGET_MS) {
      stoppedAt = n;
      upTo = Math.min(n, stable);
      break;
    }
    if (matcher.test(src.text(n))) {
      if (matches.length === MAX_MATCHES) {
        capped = true;
        break;
      }
      matches.push(n);
    }
  }
  if (capped) upTo = Math.min(n, stable);
  // Matches in the still-growing last line are not cached.
  const next: SearchCache = { key, upTo, matches: matches.filter((m) => m < upTo), capped };
  return { cache: next, matches, capped, ...(stoppedAt !== undefined && { stoppedAt }) };
}

// ---- view ---------------------------------------------------------------------------------------

const STEP_BASE = 1 << 29;
const MAX_STACK = 500;
const MAX_ERROR_LINES = 10_000;
const TOP_EVIDENCE = 5;
const STEP_EVIDENCE = 3;
const tierOf = (rank: number): EvidenceTier => EVIDENCE[Math.min(4, Math.max(0, rank))]!;
const emptyTiers = (): Tiers => ({ annotations: 0, signatures: 0, text: 0, warnings: 0 });
const K_WARNING = LINE_KINDS.indexOf("warning");
const K_WARNING_TEXT = LINE_KINDS.indexOf("warning-text");
const K_STACK = LINE_KINDS.indexOf("stack");

function addTier(t: Tiers, kind: number, rank: number): void {
  if (rank === 0 || rank === 3) t.annotations++;
  else if (rank === 1 || rank === 2) t.signatures++;
  else if (rank === 4) t.text++;
  else if (kind === K_WARNING || kind === K_WARNING_TEXT) t.warnings++;
}

/** Keeps the `max` strongest candidates: rank first, then log order. */
function keepBest(list: [number, number][], max: number, rank: number, n: number): void {
  if (list.length === max && rank >= list[max - 1]![0]) return;
  list.push([rank, n]);
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (list.length > max) list.pop();
}

type StepRow = { spec: StepSpec; collapsed: boolean; shown: number; tiers: Tiers };

export class LogView {
  /** Row value ≥ 0: an original line; -STEP_BASE < v < 0: fold index -(i + 1); ≤ -STEP_BASE: step heading -(STEP_BASE + i). */
  private rows = new Int32Array(0);
  private foldStart: number[] = [];
  private foldEnd: number[] = [];
  private foldKind: ("fold" | "gap" | "outside")[] = [];
  private stepRows: StepRow[] = [];
  private searchCache: SearchCache | null = null;
  private version = 0;
  private src: ViewSource | null = null;
  private matcher: Matcher | null = null;

  build(src: ViewSource, spec: ViewSpec): ViewSummary {
    this.src = src;
    const total = src.lineCount;
    const c = src.classified;
    const classified = Math.min(c.count, total);
    const ctx = Math.max(0, Math.min(200, Math.floor(spec.context)));
    const lo = spec.scope ? Math.max(0, spec.scope[0]) : 0;
    const hi = spec.scope ? Math.min(total - 1, spec.scope[1]) : total - 1;
    const inScope = (n: number) => n >= lo && n <= hi;

    // Search.
    let matches: number[] = [];
    let matchesCapped = false;
    let searchError: string | undefined;
    let searchStoppedAt: number | undefined;
    this.matcher = null;
    if (spec.search) {
      const compiled = compileSearch(spec.search);
      if (compiled && "error" in compiled) searchError = compiled.error;
      else if (compiled) {
        this.matcher = compiled;
        const search = spec.scope && !spec.search.scope ? { ...spec.search, scope: spec.scope } : spec.search;
        const run = runSearch(src, search, compiled, this.searchCache);
        this.searchCache = run.cache;
        matches = run.matches;
        matchesCapped = run.capped;
        searchStoppedAt = run.stoppedAt;
      }
    }

    // Visibility.
    const visible = new Uint8Array(total);
    const mark = (from: number, to: number) => visible.fill(1, Math.max(0, from), Math.min(total, to + 1));
    const selected = new Set<number>();
    for (const f of spec.filters) for (const k of FILTERS[f].kinds) selected.add(LINE_KINDS.indexOf(k));
    if (spec.mode === "problems") for (const f of ["errors", "warnings"] as const) for (const k of FILTERS[f].kinds) selected.add(LINE_KINDS.indexOf(k));
    let gapKind: "fold" | "gap" = "fold";
    const onlyMatches = Boolean(spec.search?.only && this.matcher);

    if (onlyMatches) {
      gapKind = "gap";
      for (const m of matches) mark(m - ctx, m + ctx);
    } else if (selected.size > 0) {
      gapKind = "gap";
      // Each problem line also shows the header of the step it is in, as related evidence, and the whole stack
      // trace it belongs to (a Python traceback comes before its exception line, JS and JVM frames after).
      const withHeader = spec.mode === "problems" || spec.filters.includes("errors") || spec.filters.includes("warnings");
      let h = -1;
      for (let n = lo; n < Math.min(classified, hi + 1); n++) {
        while (h + 1 < c.headers.length && c.headers[h + 1]! <= n) h++;
        if (!selected.has(c.kinds[n]!)) continue;
        mark(n - ctx, n + ctx);
        if (!withHeader) continue;
        if (h >= 0) visible[c.headers[h]!] = 1;
        let m = n - 1;
        for (; m >= 0 && n - m <= MAX_STACK && c.kinds[m] === K_STACK; m--) visible[m] = 1;
        if (m < n - 1) mark(m - ctx + 1, m);
        m = n + 1;
        for (; m < classified && m - n <= MAX_STACK && c.kinds[m] === K_STACK; m++) visible[m] = 1;
        if (m > n + 1) mark(m, m + ctx - 1);
      }
    } else if (spec.mode === "essential") {
      for (let n = 0; n < classified; n++) if (c.folds[n] === FOLD.none) visible[n] = 1;
    } else visible.fill(1, 0, classified);
    // Lines not classified yet (the still-growing last line) are shown as they are.
    visible.fill(1, classified, total);
    // Outside the scope nothing is shown unless the user expands it.
    if (spec.scope) {
      visible.fill(0, 0, lo);
      visible.fill(0, hi + 1, total);
    }
    for (const [a, b] of spec.expanded) mark(a, b);
    for (const r of spec.reveal) if (r >= 0 && r < total) visible[r] = 1;

    // Error evidence and counts in scope, overall and per step.
    const stepSpecs = (spec.steps ?? []).filter((s) => s.end >= s.start && s.start < total && s.end >= lo && s.start <= hi).sort((a, b) => a.start - b.start);
    const stepTiers = stepSpecs.map(emptyTiers);
    const stepBest = stepSpecs.map((): [number, number][] => []);
    const tiers = emptyTiers();
    const best: [number, number][] = [];
    const errorLines: number[] = [];
    const kindCounts = spec.scope ? new Array<number>(LINE_KINDS.length).fill(0) : c.counts;
    let si = 0;
    for (let n = lo; n < Math.min(classified, hi + 1); n++) {
      const kind = c.kinds[n]!;
      if (spec.scope) kindCounts[kind]!++;
      const rank = evidenceRank(kind, c.reasons[n]!);
      if (rank < 0 && kind !== K_WARNING && kind !== K_WARNING_TEXT) continue;
      addTier(tiers, kind, rank);
      while (si < stepSpecs.length && stepSpecs[si]!.end < n) si++;
      const step = si < stepSpecs.length && stepSpecs[si]!.start <= n ? si : -1;
      if (step >= 0) addTier(stepTiers[step]!, kind, rank);
      if (rank < 0) continue;
      if (errorLines.length < MAX_ERROR_LINES) errorLines.push(n);
      keepBest(best, TOP_EVIDENCE, rank, n);
      if (step >= 0) keepBest(stepBest[step]!, STEP_EVIDENCE, rank, n);
    }

    // Rows. In Essential output a heading row starts each located step; a collapsed step shows only its heading,
    // unless a line that must be visible is in it.
    const withSteps = spec.mode === "essential" && !onlyMatches && selected.size === 0 ? stepSpecs : [];
    const rows = new Int32Array(total + withSteps.length);
    this.foldStart = [];
    this.foldEnd = [];
    this.foldKind = [];
    this.stepRows = [];
    const stepRowIndex: number[] = [];
    let count = 0;
    let shown = 0;
    let next = 0;
    const stepAt = (n: number) => (next < withSteps.length && withSteps[next]!.start === n ? withSteps[next] : undefined);
    for (let n = 0; n < total; ) {
      while (next < withSteps.length && withSteps[next]!.start < n) next++;
      const step = stepAt(n);
      if (step) {
        next++;
        const end = Math.min(step.end, total - 1);
        const collapsed = step.collapsed && !spec.reveal.some((r) => r >= step.start && r <= end);
        let stepShown = 0;
        for (let m = step.start; m <= end; m++) stepShown += visible[m]!;
        this.stepRows.push({ spec: step, collapsed, shown: stepShown, tiers: stepTiers[stepSpecs.indexOf(step)]! });
        stepRowIndex.push(count);
        rows[count++] = -(STEP_BASE + this.stepRows.length - 1);
        if (collapsed) {
          n = end + 1;
          continue;
        }
      }
      if (visible[n]) {
        rows[count++] = n++;
        shown++;
        continue;
      }
      const start = n;
      const outside = !inScope(n);
      n++;
      while (n < total && !visible[n] && !inScope(n) === outside && !stepAt(n)) n++;
      this.foldStart.push(start);
      this.foldEnd.push(n - 1);
      this.foldKind.push(outside ? "outside" : gapKind);
      rows[count++] = -this.foldStart.length;
    }
    this.rows = rows.subarray(0, count);

    const counts = {} as Record<FilterKey, number>;
    for (const f of Object.keys(FILTERS) as FilterKey[]) {
      const kinds = new Set(FILTERS[f].kinds.map((k) => LINE_KINDS.indexOf(k)));
      counts[f] = [...kinds].reduce((sum, k) => sum + (kindCounts[k] ?? 0), 0);
    }
    const evidence = (list: [number, number][]) => list.map(([rank, n]) => this.evidence(n, rank));

    return {
      version: ++this.version,
      rowCount: count,
      lineCount: total,
      visibleLines: shown,
      folds: this.foldStart.length,
      matches,
      matchesCapped,
      ...(searchError !== undefined && { searchError }),
      ...(searchStoppedAt !== undefined && { searchStoppedAt }),
      counts,
      kindCounts: Object.fromEntries(LINE_KINDS.map((k, i) => [k, kindCounts[i] ?? 0])) as Record<LineKind, number>,
      tiers,
      errorLines,
      topEvidence: evidence(best),
      steps: stepSpecs.map((s, i) => ({ number: s.number, start: s.start, end: s.end, tiers: stepTiers[i]!, evidence: evidence(stepBest[i]!) })),
      stepRows: stepRowIndex,
      revealRows: spec.reveal.map((r) => this.rowOf(r)),
    };
  }

  private evidence(n: number, rank: number): Evidence {
    const c = this.src!.classified;
    const text = this.src!.text(n);
    return { n, text: text.length > 400 ? `${text.slice(0, 400)}…` : text, kind: kindOf(c.kinds[n]!), reason: reasonOf(c.reasons[n]!), rank, tier: tierOf(rank) };
  }

  private rowStart(r: number): number {
    const v = this.rows[r]!;
    if (v >= 0) return v;
    if (v <= -STEP_BASE) return this.stepRows[-v - STEP_BASE]!.spec.start;
    return this.foldStart[-v - 1]!;
  }

  /** The row showing a line (its fold row, or its collapsed step's heading, when hidden), or -1. */
  rowOf(line: number): number {
    let lo = 0;
    let hi = this.rows.length - 1;
    if (hi < 0 || line < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rowStart(mid) <= line) lo = mid;
      else hi = mid - 1;
    }
    const v = this.rows[lo]!;
    if (v >= 0) return v === line ? lo : -1;
    if (v <= -STEP_BASE) {
      const s = this.stepRows[-v - STEP_BASE]!;
      return s.collapsed && line <= s.spec.end ? lo : -1;
    }
    return line <= this.foldEnd[-v - 1]! ? lo : -1;
  }

  get currentVersion(): number {
    return this.version;
  }

  rowsAt(from: number, count: number): ViewRow[] {
    const src = this.src;
    if (!src) return [];
    const c = src.classified;
    const out: ViewRow[] = [];
    const end = Math.min(this.rows.length, from + count);
    for (let r = Math.max(0, from); r < end; r++) {
      const v = this.rows[r]!;
      if (v >= 0) {
        const classified = v < c.count;
        out.push({ t: "line", n: v, text: src.text(v), kind: classified ? kindOf(c.kinds[v]!) : "output", reason: classified ? reasonOf(c.reasons[v]!) : "not classified yet (line still loading)" });
      } else if (v <= -STEP_BASE) {
        const s = this.stepRows[-v - STEP_BASE]!;
        const preview = s.collapsed ? this.preview(s.spec) : undefined;
        out.push({ t: "step", number: s.spec.number, start: s.spec.start, end: s.spec.end, collapsed: s.collapsed, shown: s.shown, tiers: s.tiers, ...(preview && { preview }) });
      } else {
        const i = -v - 1;
        const start = this.foldStart[i]!;
        const fend = this.foldEnd[i]!;
        const kind = this.foldKind[i]!;
        out.push({ t: "fold", start, end: fend, kind, label: kind === "fold" ? foldLabel(c, start, fend) : "" });
      }
    }
    return out;
  }

  /** A collapsed step's last test or build result, else its last visible output line. */
  private preview(s: StepSpec): { n: number; text: string } | undefined {
    const src = this.src!;
    const c = src.classified;
    const last = Math.min(s.end, c.count - 1);
    let output = -1;
    for (let n = last; n >= s.start && last - n < 2000; n--) {
      const kind = kindOf(c.kinds[n]!);
      if (kind === "test" || kind === "test-failed") return { n, text: src.text(n) };
      if (output < 0 && (kind === "output" || kind === "action-output") && c.folds[n] === FOLD.none && src.text(n).trim() !== "") output = n;
    }
    return output >= 0 ? { n: output, text: src.text(output) } : undefined;
  }
}

/** Describes what a folded range holds, e.g. "runner setup · 3 groups: “Runner Image”, “Operating System”, …". */
export function foldLabel(c: LineClassifier, start: number, end: number): string {
  const codes = new Set<number>();
  for (let n = start; n <= end && n < c.count; n++) codes.add(c.folds[n]!);
  const parts: string[] = [];
  const groups = c.groups.filter((g) => g.start <= end && g.end >= start && !g.name.startsWith("Run "));
  for (const code of [FOLD.setup, FOLD.definition, FOLD.group, FOLD.repeat, FOLD.cleanup, FOLD.control]) {
    if (!codes.has(code)) continue;
    if (code === FOLD.group && groups.length > 0) {
      const names = groups.slice(0, 2).map((g) => `“${g.name}”`);
      parts.push(groups.length === 1 ? `group ${names[0]}` : `${groups.length} groups: ${names.join(", ")}${groups.length > 2 ? ", …" : ""}`);
    } else if (code === FOLD.definition) parts.push("step script and settings echoed by the runner");
    else if (code === FOLD.repeat) parts.push("repeated identical lines");
    else if (code === FOLD.control && codes.size > 1) continue;
    else parts.push(FOLDS[code]);
  }
  return parts.join(" · ");
}
