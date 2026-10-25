// Pipeline-wide search for one run attempt: job names and ids, step names, the workflow source, failure and
// dependency facts (all already loaded), and the logs of the jobs in scope. Logs are loaded on demand into a
// bounded pool of workers and searched there; only capped excerpts come back. Each log says exactly what was
// searched: the complete log, only its tail, the part received before loading stopped, or nothing.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Environment } from "../../app/environment";
import type { RunGraph } from "../../domain/graph/build";
import type { Impact } from "../../domain/insights/impact";
import type { LineKind } from "../../domain/logs/classify";
import type { FindResult } from "../../domain/logs/queries";
import { FILTERS, compileSearch, type SearchOptions } from "../../domain/logs/view";
import { buildSearchIndex, searchIndex, type EntryKind, type MetaMatch } from "../../domain/search/run-search";
import { mapSteps, type StepMapping } from "../../domain/steps/step-map";
import type { Job, RunRef } from "../../domain/types";
import type { LogLoader, LogSnapshot } from "../../logs/download/loader";
import { LogPool, SETTLED } from "../../logs/pool";
import { logStatusText, mb } from "../copy";
import { StatusIcon } from "../status";
import { jobStatus } from "../../domain/graph/build";

type Filter = "all" | "jobs" | "steps" | "errors" | "warnings" | "logs" | "source" | "failures";
const FILTER_TEXT: Record<Filter, string> = {
  all: "Everything",
  jobs: "Jobs",
  steps: "Steps",
  errors: "Errors (logs)",
  warnings: "Warnings (logs)",
  logs: "All log lines",
  source: "Workflow source",
  failures: "Failures & dependencies",
};
const META_KINDS: Partial<Record<Filter, EntryKind[]>> = { jobs: ["job"], steps: ["step"], source: ["source"], failures: ["failure"] };
const LOG_KINDS: Partial<Record<Filter, readonly LineKind[] | undefined>> = { all: undefined, logs: undefined, errors: FILTERS.errors.kinds, warnings: FILTERS.warnings.kinds };
const META_TITLE: Record<EntryKind, string> = { job: "Jobs", step: "Steps", source: "Workflow source", failure: "Failures and dependencies" };
const PER_LOG = 500;
const SHOWN = 20;

export type SearchLinks = {
  job(jobId: number): string;
  step(job: Job, step: number): string;
  /** A 1-based line of the job's complete log, with the search text highlighted. */
  line(job: Job, line: number): string;
  /** The job's log (for matches in the tail, whose absolute line number is not known). */
  log(job: Job): string;
};

type Props = {
  env: Environment;
  runRef: RunRef;
  /** Identifies the attempt: logs loaded for one attempt are discarded when it changes. */
  attemptKey: string;
  jobs: Job[];
  graph: RunGraph | null;
  impact: Impact | null;
  query: string;
  onQuery(q: string | undefined): void;
  links: SearchLinks;
};

const hasLog = (j: Job) => j.status === "completed" && j.conclusion !== "skipped";
const failed = (j: Job) => ["failure", "timed_out", "cancelled"].includes(jobStatus(j));

export function RunSearch({ env, runRef, attemptKey, jobs, graph, impact, query, onQuery, links }: Props) {
  const [text, setText] = useState(query);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<"failed" | "all">(jobs.some((j) => failed(j) && hasLog(j)) ? "failed" : "all");

  // The URL holds the applied search; typing applies it after a pause, and a newer search supersedes an older one.
  useEffect(() => {
    if (text === query) return;
    const t = window.setTimeout(() => onQuery(text || undefined), 350);
    return () => window.clearTimeout(t);
  }, [text, query, onQuery]);

  const search: SearchOptions = useMemo(() => ({ query, caseSensitive, wholeWord, regex: false }), [query, caseSensitive, wholeWord]);
  const index = useMemo(() => buildSearchIndex(graph, jobs, impact), [graph, jobs, impact]);
  const meta = useMemo((): { matches: MetaMatch[] } | { error: string } => {
    const matcher = compileSearch(search);
    if (matcher && "error" in matcher) return { error: matcher.error };
    if (filter in LOG_KINDS && filter !== "all") return { matches: [] };
    return { matches: searchIndex(index, matcher, META_KINDS[filter]) };
  }, [index, search, filter]);

  const logKinds = filter in LOG_KINDS ? LOG_KINDS[filter] : null;
  const searchesLogs = logKinds !== null && (Boolean(query) || filter === "errors" || filter === "warnings");
  const withLogs = jobs.filter(hasLog);
  const targets = scope === "failed" ? withLogs.filter(failed) : withLogs;

  // One pool per attempt (and run); logs open only when a search needs them, and close when it is left.
  const pool = useMemo(() => new LogPool(env.createLoader, 30, 2), [env, attemptKey]); // eslint-disable-line react-hooks/exhaustive-deps -- a new pool per attempt
  useEffect(() => () => pool.dispose(), [pool]);
  useSyncExternalStore(pool.subscribe, pool.version);
  const targetIds = targets.map((j) => j.id).join(",");
  useEffect(() => {
    if (!searchesLogs) return;
    for (const j of targets) pool.open({ ...runRef, jobId: j.id });
  }, [pool, searchesLogs, targetIds, runRef.owner, runRef.repo, runRef.runId]); // eslint-disable-line react-hooks/exhaustive-deps -- targets by id
  const opened = searchesLogs ? targets.filter((j) => pool.get(j.id)).map((j) => j.id) : [];
  const notOpened = searchesLogs && opened.length ? targets.filter((j) => !opened.includes(j.id)) : [];

  const [logCounts, setLogCounts] = useState<Record<number, number>>({});
  const totalLog = targets.reduce((s, j) => s + (logCounts[j.id] ?? 0), 0);
  const metaError = "error" in meta ? meta.error : null;
  const metaMatches = "matches" in meta ? meta.matches : [];
  const groups = (["failure", "job", "step", "source"] as EntryKind[]).map((k) => ({ kind: k, items: metaMatches.filter((m) => m.kind === k) })).filter((g) => g.items.length);

  return (
    <section className="run-search" aria-labelledby="search-heading" data-testid="run-search">
      <header className="panel-head">
        <h3 id="search-heading">Search this attempt</h3>
      </header>
      <form className="search-bar" role="search" onSubmit={(e) => (e.preventDefault(), onQuery(text || undefined))}>
        <input
          className="filter-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Text in job and step names, workflow source, failures and logs"
          aria-label="Search this run attempt"
          aria-describedby="search-scope"
          data-testid="search-input"
          autoComplete="off"
          spellCheck={false}
        />
        <label>
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match case
        </label>
        <label>
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Whole word
        </label>
      </form>
      <div className="search-filters" role="group" aria-label="Search in">
        {(Object.keys(FILTER_TEXT) as Filter[]).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid="search-filter" data-filter={f}>
            {FILTER_TEXT[f]}
          </button>
        ))}
      </div>
      <p id="search-scope" className="note" data-testid="search-scope">
        {logKinds === null ? (
          "Searching the run's jobs, steps, workflow source and failures (already loaded). No logs are searched with this filter."
        ) : (
          <>
            Logs searched:{" "}
            <select value={scope} onChange={(e) => setScope(e.target.value as "failed" | "all")} aria-label="Logs to search" data-testid="search-log-scope">
              <option value="failed">failed and cancelled jobs ({withLogs.filter(failed).length})</option>
              <option value="all">all jobs with a log ({withLogs.length})</option>
            </select>{" "}
            of this attempt. Each log is downloaded when first searched and kept until you leave the search.
            {filter === "errors" || filter === "warnings" ? " With an empty search, every line of that kind is listed." : ""}
          </>
        )}
      </p>

      {!query && !searchesLogs && <p className="state">Type to search.</p>}
      {metaError && <p className="state state-error">The search text is not valid: {metaError}</p>}
      {query && !metaError && (
        <p className="note" role="status" data-testid="run-search-summary">
          {metaMatches.length} match{metaMatches.length === 1 ? "" : "es"} in jobs, steps, source and failures
          {searchesLogs ? `; ${totalLog}${targets.some((j) => (logCounts[j.id] ?? 0) >= PER_LOG) ? "+" : ""} in ${targets.length} log${targets.length === 1 ? "" : "s"} (see what each log covered below)` : ""}.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.kind} className="search-group" data-testid="search-group" data-kind={g.kind}>
          <h4>{META_TITLE[g.kind]}</h4>
          <ul className="search-results">
            {g.items.slice(0, 50).map((m, i) => (
              <li key={i} data-testid="search-result" data-kind={m.kind}>
                <a href={metaHref(m, jobs, links)}>
                  <Highlighted text={m.text} ranges={m.ranges} />
                </a>{" "}
                <span className="muted">{m.context}</span>
              </li>
            ))}
            {g.items.length > 50 && <li className="muted">and {g.items.length - 50} more; refine the search to see them.</li>}
          </ul>
        </section>
      ))}

      {searchesLogs && (
        <section className="search-group" data-testid="search-logs">
          <h4>Logs</h4>
          {targets.length === 0 && <p className="note">No job in this scope has a log (skipped or unfinished jobs have none).</p>}
          {targets
            .filter((j) => opened.includes(j.id))
            .map((j) => (
              <LogResults
                key={j.id}
                loader={pool.get(j.id)!}
                job={j}
                search={search}
                kinds={logKinds as LineKind[] | undefined}
                links={links}
                onCount={(n) => setLogCounts((c) => (c[j.id] === n ? c : { ...c, [j.id]: n }))}
              />
            ))}
          {notOpened.length > 0 && (
            <p className="note" data-testid="search-not-searched">
              Not searched: {notOpened.length} log{notOpened.length === 1 ? "" : "s"} beyond the limit of {pool.max} logs per search ({notOpened.slice(0, 5).map((j) => j.name).join(", ")}
              {notOpened.length > 5 ? "…" : ""}). Narrow the scope to failed jobs, or open a job's log directly.
            </p>
          )}
        </section>
      )}
    </section>
  );
}

function metaHref(m: MetaMatch, jobs: Job[], links: SearchLinks): string | undefined {
  const job = m.jobId !== undefined ? jobs.find((j) => j.id === m.jobId) : undefined;
  if (job && m.step !== undefined) return links.step(job, m.step);
  if (m.jobId !== undefined) return links.job(m.jobId);
  return undefined;
}

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a < at) return;
    parts.push(text.slice(at, a));
    parts.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** What part of the log a search covered, in words. */
export function coverage(s: LogSnapshot, lines: number): { text: string; searched: boolean; partial: boolean } {
  switch (s.status) {
    case "complete":
      return { text: `searched the complete log (${lines.toLocaleString()} lines)`, searched: true, partial: false };
    case "tail-only":
      return {
        text: `searched only the last ${lines.toLocaleString()} lines: the log is ${s.bytesTotal !== undefined ? mb(s.bytesTotal) : "large"}, above the size that loads automatically`,
        searched: true,
        partial: true,
      };
    case "incomplete":
    case "cancelled":
      return {
        text: `searched only the ${lines.toLocaleString()} lines received before loading stopped (${mb(s.bytesLoaded)}${s.bytesTotal !== undefined ? ` of ${mb(s.bytesTotal)}` : ""})`,
        searched: true,
        partial: true,
      };
    default:
      return { text: SETTLED.includes(s.status) ? `not searched: ${logStatusText(s)}` : `not searched yet: ${logStatusText(s)}`, searched: false, partial: false };
  }
}

function LogResults({
  loader,
  job,
  search,
  kinds,
  links,
  onCount,
}: {
  loader: LogLoader;
  job: Job;
  search: SearchOptions;
  kinds: LineKind[] | undefined;
  links: SearchLinks;
  onCount(n: number): void;
}) {
  const snap = useSyncExternalStore(
    (on) => loader.subscribe(on),
    () => loader.snapshot,
  );
  const usable = ["complete", "tail-only", "incomplete", "cancelled"].includes(snap.status);
  const doc = snap.status === "tail-only" ? "tail" : "full";
  const key = JSON.stringify([search, kinds, doc, snap.status, snap.lines]);
  const [result, setResult] = useState<{ key: string; value: FindResult | null } | null>(null);
  useEffect(() => {
    if (!usable) return;
    let live = true;
    void loader.find(doc, search, kinds, PER_LOG).then((value) => {
      if (live) setResult({ key, value });
    });
    return () => {
      live = false;
    };
  }, [loader, key]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` covers the inputs
  const [mapping, setMapping] = useState<StepMapping | null>(null);
  useEffect(() => {
    if (snap.status !== "complete" || !job.steps) return;
    let live = true;
    void loader.markers().then((m) => {
      if (live && m) setMapping(mapSteps(job.steps!, m));
    });
    return () => {
      live = false;
    };
  }, [loader, snap.status, job.steps]);
  const [all, setAll] = useState(false);

  const current = result?.key === key ? result.value : null;
  const matches = current && "matches" in current ? current.matches : [];
  useEffect(() => onCount(matches.length), [matches.length]); // eslint-disable-line react-hooks/exhaustive-deps -- report the count only
  const cover = coverage(snap, current && "lines" in current ? current.lines : snap.lines);
  const stepAt = (line: number) => {
    const seg = mapping?.segments.find((s) => line + 1 >= s.startLine && line + 1 <= s.endLine);
    return seg ? job.steps?.find((s) => s.number === seg.stepNumber)?.name : undefined;
  };

  return (
    <article className="search-log" data-testid="search-log" data-job={job.id} data-status={snap.status} data-searched={cover.searched && current ? "yes" : "no"}>
      <h5>
        <StatusIcon status={jobStatus(job)} /> {job.name}{" "}
        <span className="muted" data-testid="search-log-count">
          {usable && current ? `${matches.length}${current && "capped" in current && current.capped ? "+" : ""} match${matches.length === 1 ? "" : "es"}` : ""}
        </span>
      </h5>
      <p className={`note${cover.partial ? " partial" : ""}`} data-testid="search-log-coverage">
        {usable && !current ? "searching…" : cover.text}
        {snap.status === "tail-only" && (
          <>
            {" "}
            <button type="button" onClick={() => void loader.loadFull()}>
              Load and search the full log
            </button>
          </>
        )}
      </p>
      {current && "error" in current && <p className="state state-error">{current.error}</p>}
      {usable && current && matches.length === 0 && "matches" in current && <p className="muted">No match in what was searched.</p>}
      {matches.length > 0 && (
        <ul className="search-results">
          {(all ? matches : matches.slice(0, SHOWN)).map((m) => (
            <li key={m.line} data-testid="search-result" data-kind="log" data-line={doc === "full" ? m.line + 1 : undefined}>
              <a href={doc === "full" ? links.line(job, m.line + 1) : links.log(job)} className="search-line">
                {doc === "full" ? `L${m.line + 1}` : "tail"}
              </a>{" "}
              {doc === "full" && stepAt(m.line) && <span className="muted">{stepAt(m.line)} · </span>}
              <span className={`kind k-${m.kind}`}>{m.kind}</span>{" "}
              <code className="search-excerpt">
                <Highlighted text={m.text} ranges={m.ranges} />
              </code>
            </li>
          ))}
          {!all && matches.length > SHOWN && (
            <li>
              <button type="button" className="linklike" onClick={() => setAll(true)}>
                Show all {matches.length}
              </button>
            </li>
          )}
          {current && "capped" in current && current.capped && <li className="muted">Stopped at {PER_LOG} matches in this log; refine the search.</li>}
        </ul>
      )}
    </article>
  );
}
