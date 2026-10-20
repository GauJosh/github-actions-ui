import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Environment } from "../app/environment";
import { hasLogOutput, locateStep, mapSteps, targetLine, type LogMarkers, type StepLocation } from "../domain/steps/step-map";
import type { Job, JobRef, Step } from "../domain/types";
import type { LogLoader, LogSnapshot } from "../logs/download/loader";
import { count, logStatusText, mb } from "./copy";
import { VirtualLog } from "./VirtualLog";

/** Links that keep the user's place (run, phase, view, job and step) in the URL. */
export type LogLinks = { line(n: number): string; step(n: number): string };

/** One loader per job. Creating it has no side effects; the effect starts it and disposes it (terminating its worker). */
function useLoader(env: Environment, ref: JobRef): LogLoader {
  const { owner, repo, runId, jobId } = ref;
  const loader = useMemo(() => env.createLoader({ owner, repo, runId, jobId }), [env, owner, repo, runId, jobId]);
  useEffect(() => {
    void loader.start();
    return () => loader.dispose();
  }, [loader]);
  return loader;
}

type PanelProps = { job: Job; line?: number; step?: number; links: LogLinks };

export function LogPanel({ env, jobRef, ...rest }: PanelProps & { env: Environment; jobRef: JobRef }) {
  const loader = useLoader(env, jobRef);
  return <LoadedLogPanel key={rest.job.id} loader={loader} {...rest} />;
}

const ERROR_MARKER = "##[error]";

function LoadedLogPanel({ loader, job, line, step, links }: PanelProps & { loader: LogLoader }) {
  const snap = useSyncExternalStore(
    useCallback((onChange: () => void) => loader.subscribe(onChange), [loader]),
    () => loader.snapshot,
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; lines: number[]; capped: boolean; partial: boolean } | null>(null);
  const fetchRows = useCallback((from: number, n: number) => loader.rows("full", from, n), [loader]);
  const status = snap.status;
  const showFull = snap.lines > 0 && ["loading", "cancelled", "complete", "incomplete"].includes(status);
  const showTail = snap.tail !== undefined && status !== "complete";
  const searchable = showFull;

  // Step markers are scanned once per completed load (a worker restart or retry gives a new load).
  const loadKey = `${snap.restarts}:${snap.crc32 ?? ""}`;
  const wantMarkers = step !== undefined && status === "complete";
  const [scanned, setScanned] = useState<{ key: string; markers: LogMarkers | null } | null>(null);
  useEffect(() => {
    if (!wantMarkers) return;
    let live = true;
    void loader.markers().then((markers) => {
      if (live) setScanned({ key: loadKey, markers });
    });
    return () => {
      live = false;
    };
  }, [loader, wantMarkers, loadKey]);
  const markers = wantMarkers && scanned?.key === loadKey ? scanned.markers : undefined;
  const mapping = useMemo(() => (markers && job.steps ? mapSteps(job.steps, markers) : undefined), [markers, job.steps]);
  const stepInfo = step !== undefined ? job.steps?.find((s) => s.number === step) : undefined;
  const location = step !== undefined && mapping && job.steps ? locateStep(job.steps, mapping, step) : undefined;
  const segment = location?.kind === "segment" ? location.segment : undefined;
  const target = line ?? (segment ? targetLine(segment, stepInfo) : undefined);

  // Bring the step's evidence into view when a step is chosen.
  const locatorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== undefined) locatorRef.current?.scrollIntoView({ block: "start" });
  }, [step]);

  async function search(q: string) {
    const result = await loader.search(q);
    if (result) setHits({ query: q, ...result, partial: loader.snapshot.status !== "complete" });
  }
  function runSearch(event: React.FormEvent) {
    event.preventDefault();
    void search(query);
  }
  function findErrors() {
    setQuery(ERROR_MARKER);
    void search(ERROR_MARKER);
  }

  return (
    <section className="panel log-panel" aria-label={`Log for job ${job.name}`}>
      <header className="panel-head">
        <h3>Log · {job.name}</h3>
        {job.html_url && (
          <a href={job.html_url} target="_blank" rel="noreferrer noopener">
            Open log on GitHub
          </a>
        )}
      </header>

      <div className={`status status-${status}`} role="status" data-testid="log-status" data-status={status}>
        <span>{logStatusText(snap)}</span>
        {status === "loading" && <button onClick={() => loader.cancel()}>Pause</button>}
        {status === "cancelled" && <button onClick={() => loader.resume()}>Resume</button>}
        {status === "tail-only" && (
          <button onClick={() => void loader.loadFull()}>Load full log ({snap.bytesTotal !== undefined ? mb(snap.bytesTotal) : "?"}) for search and step navigation</button>
        )}
        {(status === "incomplete" || status === "processing-failed" || status === "failed") && <button onClick={() => void loader.retry()}>Retry</button>}
      </div>
      {status === "tail-only" && <p className="note">Large logs use memory roughly in proportion to their size.</p>}
      {snap.notice?.kind === "range-unsupported" && <p className="note">The log host ignored the byte range; downloading the whole log instead.</p>}

      {step !== undefined && (
        <StepLocator
          anchorRef={locatorRef}
          job={job}
          step={step}
          stepInfo={stepInfo}
          snap={snap}
          scanFailed={wantMarkers && markers === null}
          location={location}
          showingLine={line}
          links={links}
          onFindErrors={findErrors}
        />
      )}

      {showTail && snap.tail && (
        <div className="tail" data-testid="tail-evidence">
          <h4>
            End of log: last {count(snap.tail.lines.length)} lines {snap.tail.fromInterruptedLoad && <em>(from the interrupted load)</em>}
          </h4>
          <ol className="tail-lines">
            {snap.tail.lines.map((text, i) => (
              <li key={i}>
                <span className="ln">−{snap.tail!.lines.length - i}</span>
                <span className="tx">{text}</span>
              </li>
            ))}
          </ol>
          <p className="note">Lines are numbered from the end because absolute line numbers need the full log.</p>
        </div>
      )}

      {status === "tail-only" && <p className="note">Search: unavailable until the full log is loaded. Step boundaries: unavailable until the full log is loaded.</p>}

      {searchable && (
        <form className="search" onSubmit={runSearch} role="search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search log (case-sensitive)" aria-label="Search log" />
          <button type="submit" disabled={!query}>
            Search
          </button>
          {hits && (
            <span className="hits" data-testid="search-summary">
              {hits.lines.length === 0 ? "No matches" : `${count(hits.lines.length)}${hits.capped ? "+" : ""} matching lines`}
              {hits.partial && " in the bytes loaded so far"}
            </span>
          )}
        </form>
      )}
      {hits && hits.lines.length > 0 && (
        <ul className="hit-list" data-testid="search-hits">
          {hits.lines.slice(0, 50).map((n) => (
            <li key={n}>
              <a href={links.line(n + 1)}>Line {n + 1}</a>
            </li>
          ))}
        </ul>
      )}

      {showFull && (
        <VirtualLog
          lineCount={snap.lines}
          fetchRows={fetchRows}
          highlight={target}
          range={segment ? { start: segment.startLine, end: segment.endLine, marks: segment.errorLines } : undefined}
          hrefFor={links.line}
        />
      )}
      {line !== undefined && showFull && line > snap.lines && <p className="note">Line {line} is not loaded yet.</p>}

      <details className="diagnostics">
        <summary>Diagnostics</summary>
        <p className="note">Hosts, statuses, offsets and timings only. Download links and tokens are never recorded.</p>
        <dl>
          <dt>Bytes received</dt>
          <dd data-testid="diag-bytes">{count(snap.bytesLoaded)}</dd>
          <dt>Reported size</dt>
          <dd>{snap.bytesTotal !== undefined ? count(snap.bytesTotal) : "unknown"}</dd>
          <dt>Worker restarts</dt>
          <dd>{snap.restarts}</dd>
          <dt>CRC32 (diagnostic)</dt>
          <dd data-testid="diag-crc32">{snap.crc32 !== undefined ? snap.crc32.toString(16).padStart(8, "0") : "n/a"}</dd>
          {mapping && (
            <>
              <dt>Step mapping</dt>
              <dd data-testid="diag-mapping">{mapping.mapping === "exact-checks-passed" ? "consistency checks passed" : mapping.mapping}</dd>
            </>
          )}
        </dl>
        <ol className="events" data-testid="diag-events">
          {loader.events.map((e, i) => (
            <li key={i} data-event={e.event}>
              {e.t} ms · {e.event}
              {e.host ? ` · ${e.host}` : ""}
              {e.status ? ` · ${e.status}` : ""}
              {e.offset !== undefined ? ` · offset ${e.offset}` : ""}
              {e.detail ? ` · ${e.detail}` : ""}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

const FAILED = new Set(["failure", "timed_out", "cancelled"]);

type LocatorProps = {
  anchorRef: React.Ref<HTMLDivElement>;
  job: Job;
  step: number;
  stepInfo?: Step;
  snap: LogSnapshot;
  scanFailed: boolean;
  location?: StepLocation;
  showingLine?: number;
  links: LogLinks;
  onFindErrors(): void;
};

/** Where the selected step's output is in the log, or why it cannot be shown and what to do instead. */
function StepLocator({ anchorRef, job, step, stepInfo, snap, scanFailed, location, showingLine, links, onFindErrors }: LocatorProps) {
  const failed = FAILED.has(stepInfo?.conclusion ?? "");
  const title = stepInfo ? `Step ${step}: ${stepInfo.name}` : `Step ${step}`;
  let state: string;
  let body: React.ReactNode;

  if (!job.steps) {
    state = "unavailable";
    body = <p>GitHub returned no step data for this job, so its steps cannot be located in the log.</p>;
  } else if (!stepInfo) {
    state = "unavailable";
    body = <p>Step {step} is not in GitHub's step list for this job.</p>;
  } else if (!hasLogOutput(stepInfo)) {
    state = "no-output";
    body = <p>{stepInfo.conclusion === "skipped" ? "This step was skipped, so it wrote nothing to the log." : "This step has not run, so it has no log output."}</p>;
  } else if (snap.status === "tail-only") {
    state = "needs-full-log";
    body = (
      <p>
        Finding a step's lines needs the full log, because absolute line numbers need it. This log is large{snap.bytesTotal !== undefined ? ` (${mb(snap.bytesTotal)})` : ""}, so only its end was
        loaded. Use “Load full log” above to find this step.{failed && " Meanwhile, the end of the log is shown below; failure evidence is usually there."}
      </p>
    );
  } else if (snap.status === "cancelled") {
    state = "paused";
    body = <p>Loading is paused. Resume it to find this step's lines.</p>;
  } else if (snap.status !== "complete" && ["sizing", "tail", "loading"].includes(snap.status)) {
    state = "waiting";
    body = <p>Finding this step's lines once the full log has loaded…{failed && " The end of the log is shown below in the meantime."}</p>;
  } else if (snap.status !== "complete") {
    state = "log-unavailable";
    body = <p>This step's lines cannot be found because the full log is not available ({logStatusText(snap)}).</p>;
  } else if (scanFailed) {
    state = "unmatched";
    body = <Fallback failed={failed} issues={["The log could not be scanned for step markers."]} onFindErrors={onFindErrors} />;
  } else if (!location) {
    state = "locating";
    body = <p>Locating this step in the log…</p>;
  } else if (location.kind !== "segment") {
    state = location.kind === "no-output" ? "no-output" : "unmatched";
    body =
      location.kind === "no-output" ? (
        <p>This step wrote nothing to the log.</p>
      ) : (
        <Fallback failed={failed} issues={location.issues} onFindErrors={onFindErrors} />
      );
  } else {
    const { segment, approximate, issues } = location;
    state = approximate ? "approximate" : "found";
    const shownError = failed && segment.errorLines.length > 0 && showingLine === undefined;
    body = (
      <>
        <p data-testid="step-range">
          {approximate ? "Approximately lines" : "Lines"} {segment.startLine}–{segment.endLine}
          {shownError ? `. Showing its first error line (${segment.errorLines[0]}).` : showingLine !== undefined ? `. Showing line ${showingLine}.` : ". Showing its first line."}{" "}
          <a href={links.line(segment.startLine)}>Step start</a>
        </p>
        {segment.errorLines.length > 0 && (
          <p className="step-errors" data-testid="step-errors">
            Error lines in this step:{" "}
            {segment.errorLines.slice(0, 12).map((n) => (
              <a key={n} href={links.line(n)}>
                {n}
              </a>
            ))}
            {segment.errorLines.length > 12 && ` and ${count(segment.errorLines.length - 12)} more`}
          </p>
        )}
        {approximate ? (
          <div className="step-warning" data-testid="step-approximate">
            <strong>Step boundaries approximate.</strong> These lines may include output from neighbouring steps, or miss some of this step's output.
            <ul>
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="note">From the runner's log markers; the consistency checks passed. GitHub runner log markers may not always give exact step boundaries.</p>
        )}
      </>
    );
  }

  return (
    <div className="step-locator" ref={anchorRef} data-testid="step-locator" data-state={state} aria-live="polite">
      <div className="step-locator-head">
        <strong>{title}</strong>
        <a
          href="#job-details"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("job-details")?.scrollIntoView();
          }}
        >
          ↑ Job details and steps
        </a>
      </div>
      {body}
    </div>
  );
}

function Fallback({ failed, issues, onFindErrors }: { failed: boolean; issues: string[]; onFindErrors(): void }) {
  return (
    <>
      <p>Where this step starts in the log could not be established, so no lines are attributed to it.</p>
      {issues.length > 0 && (
        <ul className="step-issues">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {failed ? (
        <p>
          <button onClick={onFindErrors} data-testid="find-errors">
            Find error lines in the whole log
          </button>{" "}
          The step failed; its error lines are usually marked <code>{ERROR_MARKER}</code>.
        </p>
      ) : (
        <p>Search the log below, or open it on GitHub, which shows each step's output separately.</p>
      )}
    </>
  );
}
