// Log display modes, quick filters, context and search controls (docs/ARCHITECTURE.md §8.1).
import { FILTERS, FILTER_KEYS, MAX_MATCHES, type FilterKey, type LogMode, type ViewSummary } from "../domain/logs/view";
import { count } from "./copy";
import { setLogPrefs, type LogPrefs } from "./log-prefs";

const MODES: { mode: LogMode; label: string; title: string }[] = [
  { mode: "essential", label: "Essential output", title: "Folds runner control markers, job setup and cleanup messages, closed groups, the runner's echo of each step's script and settings, and repeated lines. Everything else stays visible." },
  { mode: "all", label: "All output", title: "Every original line, unchanged." },
  { mode: "problems", label: "Errors & warnings", title: "Runner error and warning annotations, failure signatures (exceptions with their stack traces, error codes, compiler errors, test failures), and text that looks like an error or warning, with context lines and the step header." },
];
const CONTEXTS = [0, 1, 3, 5, 10, 25];

type Props = {
  prefs: LogPrefs;
  summary: ViewSummary | null;
  /** The log is still loading or stopped early: counts and matches cover the lines loaded so far. */
  partial: boolean;
  query: string;
  onQuery(query: string): void;
  /** The query the current results are for. */
  applied: string;
  onSearch(): void;
  /** The selected step and its 1-based lines, when it was located. */
  step?: { number: number; start: number; end: number };
  /** Index of the current match in `summary.matches`. */
  current: number | null;
  onMove(delta: 1 | -1): void;
  /** Index of the current line in `summary.errorLines`. */
  currentError: number | null;
  onMoveError(delta: 1 | -1): void;
  expanded: number;
  onCollapse(): void;
};

export function LogControls({ prefs, summary, partial, query, onQuery, applied, onSearch, step, current, onMove, currentError, onMoveError, expanded, onCollapse }: Props) {
  const toggleFilter = (f: FilterKey) => setLogPrefs({ filters: prefs.filters.includes(f) ? prefs.filters.filter((x) => x !== f) : [...prefs.filters, f] });
  const matches = summary?.matches ?? [];
  const searched = applied !== "" && summary !== null;
  const scoped = prefs.scope === "step" && step !== undefined;
  const scopeText = `${scoped ? `step ${step.number} (lines ${count(step.start)}–${count(step.end)})` : "the whole job log"}${partial ? ", lines loaded so far" : ""}`;
  const errors = summary?.errorLines ?? [];
  const t = summary?.tiers;

  return (
    <div className="log-controls" data-testid="log-controls">
      <div className="log-modes" role="tablist" aria-label="Log display mode">
        {MODES.map((m) => (
          <button key={m.mode} type="button" role="tab" aria-selected={prefs.mode === m.mode} className={prefs.mode === m.mode ? "active" : ""} title={m.title} onClick={() => setLogPrefs({ mode: m.mode })}>
            {m.label}
          </button>
        ))}
        <label className="log-context">
          Context
          <select value={prefs.context} onChange={(e) => setLogPrefs({ context: Number(e.target.value) })} aria-label="Context lines">
            {CONTEXTS.map((c) => (
              <option key={c} value={c}>
                {c} {c === 1 ? "line" : "lines"}
              </option>
            ))}
          </select>
        </label>
        {step && (
          <label className="log-context">
            Scope
            <select value={prefs.scope} onChange={(e) => setLogPrefs({ scope: e.target.value as LogPrefs["scope"] })} aria-label="Scope">
              <option value="job">Whole job log</option>
              <option value="step">
                Step {step.number} only (lines {step.start}–{step.end})
              </option>
            </select>
          </label>
        )}
        {expanded > 0 && (
          <button type="button" className="link-button" onClick={onCollapse}>
            Fold expanded lines again ({expanded})
          </button>
        )}
      </div>

      <div className="log-filters" role="group" aria-label="Quick filters">
        <span className="scope-label" data-testid="count-scope">
          Counts in {scopeText}:
        </span>
        {FILTER_KEYS.map((f) => (
          <button
            key={f}
            type="button"
            className={`lchip${prefs.filters.includes(f) ? " active" : ""}`}
            aria-pressed={prefs.filters.includes(f)}
            onClick={() => toggleFilter(f)}
            data-filter={f}
            title={f === "errors" && t ? `${count(t.annotations)} runner error annotations, ${count(t.signatures)} failure signatures, ${count(t.text)} lines that only look like errors` : undefined}
          >
            {FILTERS[f].label}
            {summary && <span className="lchip-count">{count(summary.counts[f])}</span>}
          </button>
        ))}
        {prefs.filters.length > 0 && (
          <button type="button" className="link-button" onClick={() => setLogPrefs({ filters: [] })}>
            Clear filters
          </button>
        )}
        {errors.length > 0 && (
          <span className="match-nav error-nav" data-testid="error-nav">
            <button type="button" onClick={() => onMoveError(-1)} aria-label="Previous error">
              ↑
            </button>
            <button type="button" onClick={() => onMoveError(1)} aria-label="Next error">
              ↓
            </button>
            <span data-testid="error-position">{currentError !== null ? `Error ${count(currentError + 1)} of ${count(errors.length)}` : `${count(errors.length)} error ${errors.length === 1 ? "line" : "lines"}`}</span>
          </span>
        )}
      </div>

      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
        }}
      >
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search log" aria-label="Search log" spellCheck={false} />
        <Toggle label="Aa" title="Match case" on={prefs.caseSensitive} set={(v) => setLogPrefs({ caseSensitive: v })} />
        <Toggle label="W" title="Whole word" on={prefs.wholeWord} set={(v) => setLogPrefs({ wholeWord: v })} />
        <Toggle label=".*" title="Regular expression" on={prefs.regex} set={(v) => setLogPrefs({ regex: v })} />
        <label className="only">
          <input type="checkbox" checked={prefs.only} onChange={(e) => setLogPrefs({ only: e.target.checked })} /> Only matching lines
        </label>
        <button type="submit" disabled={!query}>
          Search
        </button>
        {searched && !summary.searchError && (
          <>
            <span className="hits" data-testid="search-summary">
              {matches.length === 0 ? "No matches" : `${count(matches.length)}${summary.matchesCapped ? "+" : ""} matching lines`}
              {scoped && ` in step ${step.number}`}
              {partial && " in the bytes loaded so far"}
            </span>
            {matches.length > 0 && (
              <span className="match-nav">
                <button type="button" onClick={() => onMove(-1)} aria-label="Previous match">
                  ↑
                </button>
                <button type="button" onClick={() => onMove(1)} aria-label="Next match">
                  ↓
                </button>
                <span data-testid="search-position">{current !== null ? `${count(current + 1)} of ${count(matches.length)}` : ""}</span>
              </span>
            )}
          </>
        )}
      </form>
      {searched && summary.searchError && (
        <p className="search-error" role="alert" data-testid="search-error">
          Invalid regular expression: {summary.searchError}. Nothing was searched.
        </p>
      )}
      {searched && summary.matchesCapped && <p className="note">Showing the first {count(MAX_MATCHES)} matches. Refine the search to see the rest.</p>}
      {searched && summary.searchStoppedAt !== undefined && (
        <p className="note" data-testid="search-stopped">
          The regular expression took too long; lines after {count(summary.searchStoppedAt + 1)} were not searched. Simplify it to search the whole log.
        </p>
      )}
    </div>
  );
}

function Toggle({ label, title, on, set }: { label: string; title: string; on: boolean; set(v: boolean): void }) {
  return (
    <button type="button" className={`toggle${on ? " active" : ""}`} aria-pressed={on} aria-label={title} title={title} onClick={() => set(!on)}>
      {label}
    </button>
  );
}

/** One line describing what the view shows, and what classification means. */
export function ViewDescription({ prefs, summary, partial, steps }: { prefs: LogPrefs; summary: ViewSummary; partial: boolean; steps: number }) {
  const k = summary.kindCounts;
  const t = summary.tiers;
  const loaded = partial ? ` of the ${count(summary.lineCount)} lines loaded so far` : ` of ${count(summary.lineCount)}`;
  let text: string;
  if (prefs.only && summary.matches.length > 0) text = `Matching lines with ${prefs.context} lines of context: ${count(summary.visibleLines)}${loaded} lines shown.`;
  else if (prefs.mode === "problems" || prefs.filters.length > 0) {
    const problems = `${count(k.error)} error and ${count(k.warning)} warning annotations, ${count(t.signatures)} failure signatures, ${count(k["error-text"] + k["warning-text"])} lines that only look like errors or warnings`;
    text = prefs.mode === "problems" ? `Errors & warnings: ${problems}. ${count(summary.visibleLines)}${loaded} lines shown, with ${prefs.context} lines of context.` : `Filtered: ${count(summary.visibleLines)}${loaded} lines shown, with ${prefs.context} lines of context.`;
  } else if (prefs.mode === "essential")
    text = `Essential output${steps > 0 ? `, by step (${count(steps)} steps)` : ""}: ${count(summary.visibleLines)}${loaded} lines shown; the rest are in ${count(summary.folds)} expandable ${summary.folds === 1 ? "row" : "rows"}${steps > 0 ? " or collapsed steps" : ""}. Unrecognised lines are never folded.`;
  else text = `All output: every line${partial ? " loaded so far" : ""}, unchanged.`;
  const none = prefs.mode === "problems" && prefs.filters.length === 0 && k.error + k.warning + k["error-text"] + k["warning-text"] + k["test-failed"] + k["error-signature"] === 0;
  return (
    <>
      <p className="note view-description" data-testid="log-view-summary">
        {text} Badges: <span className="kbadge kbadge-annotation">error</span> is a runner annotation; <span className="kbadge kbadge-signature">exception</span> and other
        filled badges are failure signatures that tools print when something fails; <span className="kbadge kbadge-text">error?</span> marks text that only looks like an error. Only
        GitHub&apos;s step result shows that a step failed.
      </p>
      {none && (
        <p className="note" data-testid="no-problems">
          No error or warning annotations, failure signatures, or error- or warning-like text, in the lines {partial ? "loaded so far" : "of this log"}
          {prefs.scope === "step" ? " in this step" : ""}.
        </p>
      )}
    </>
  );
}
