// Log display modes, quick filters, context and search controls (docs/ARCHITECTURE.md §8.1).
import { FILTERS, FILTER_KEYS, MAX_MATCHES, type FilterKey, type LogMode, type ViewSummary } from "../domain/logs/view";
import { count } from "./copy";
import { setLogPrefs, type LogPrefs } from "./log-prefs";

const MODES: { mode: LogMode; label: string; title: string }[] = [
  { mode: "essential", label: "Essential output", title: "Folds runner control markers, job setup and cleanup messages, closed groups, the runner's echo of each step's script and settings, and repeated lines. Everything else stays visible." },
  { mode: "all", label: "All output", title: "Every original line, unchanged." },
  { mode: "problems", label: "Errors & warnings", title: "Runner error and warning annotations, and text that looks like an error or warning, with context lines and the step header." },
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
  /** 1-based lines of the selected step, when it was located. */
  step?: { start: number; end: number };
  /** Index of the current match in `summary.matches`. */
  current: number | null;
  onMove(delta: 1 | -1): void;
  expanded: number;
  onCollapse(): void;
};

export function LogControls({ prefs, summary, partial, query, onQuery, applied, onSearch, step, current, onMove, expanded, onCollapse }: Props) {
  const toggleFilter = (f: FilterKey) => setLogPrefs({ filters: prefs.filters.includes(f) ? prefs.filters.filter((x) => x !== f) : [...prefs.filters, f] });
  const matches = summary?.matches ?? [];
  const searched = applied !== "" && summary !== null;

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
        {expanded > 0 && (
          <button type="button" className="link-button" onClick={onCollapse}>
            Fold expanded lines again ({expanded})
          </button>
        )}
      </div>

      <div className="log-filters" role="group" aria-label="Quick filters">
        {FILTER_KEYS.map((f) => (
          <button key={f} type="button" className={`lchip${prefs.filters.includes(f) ? " active" : ""}`} aria-pressed={prefs.filters.includes(f)} onClick={() => toggleFilter(f)} data-filter={f}>
            {FILTERS[f].label}
            {summary && <span className="lchip-count">{count(summary.counts[f])}</span>}
          </button>
        ))}
        {prefs.filters.length > 0 && (
          <button type="button" className="link-button" onClick={() => setLogPrefs({ filters: [] })}>
            Clear filters
          </button>
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
        {step && (
          <select value={prefs.scope} onChange={(e) => setLogPrefs({ scope: e.target.value as LogPrefs["scope"] })} aria-label="Search in">
            <option value="job">Whole job log</option>
            <option value="step">
              Selected step (lines {step.start}–{step.end})
            </option>
          </select>
        )}
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
export function ViewDescription({ prefs, summary, partial }: { prefs: LogPrefs; summary: ViewSummary; partial: boolean }) {
  const k = summary.kindCounts;
  const loaded = partial ? ` of the ${count(summary.lineCount)} lines loaded so far` : ` of ${count(summary.lineCount)}`;
  let text: string;
  if (prefs.only && summary.matches.length > 0) text = `Matching lines with ${prefs.context} lines of context: ${count(summary.visibleLines)}${loaded} lines shown.`;
  else if (prefs.mode === "problems" || prefs.filters.length > 0) {
    const problems = `${count(k.error)} error and ${count(k.warning)} warning annotations, ${count(k["error-text"] + k["warning-text"] + k["test-failed"])} lines that look like errors, warnings or test failures`;
    text = prefs.mode === "problems" ? `Errors & warnings: ${problems}. ${count(summary.visibleLines)}${loaded} lines shown, with ${prefs.context} lines of context.` : `Filtered: ${count(summary.visibleLines)}${loaded} lines shown, with ${prefs.context} lines of context.`;
  } else if (prefs.mode === "essential") text = `Essential output: ${count(summary.visibleLines)}${loaded} lines shown; ${count(summary.lineCount - summary.visibleLines)} folded into ${count(summary.folds)} expandable rows. Unrecognised lines are never folded.`;
  else text = `All output: every line${partial ? " loaded so far" : ""}, unchanged.`;
  const none = prefs.mode === "problems" && prefs.filters.length === 0 && k.error + k.warning + k["error-text"] + k["warning-text"] + k["test-failed"] === 0;
  return (
    <>
      <p className="note view-description" data-testid="log-view-summary">
        {text} Badges: <span className="kbadge kbadge-error">error</span> and <span className="kbadge kbadge-warning">warning</span> are runner annotations;{" "}
        <span className="kbadge kbadge-error-text">error?</span> marks text that only looks like one, which does not show that a command failed.
      </p>
      {none && (
        <p className="note" data-testid="no-problems">
          No error or warning annotations, and no error- or warning-like text, in the lines {partial ? "loaded so far" : "of this log"}.
        </p>
      )}
    </>
  );
}
