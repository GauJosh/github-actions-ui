import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Environment } from "../app/environment";
import { routeToHash } from "../domain/run-url";
import type { Job, JobRef } from "../domain/types";
import type { LogLoader } from "../logs/download/loader";
import { count, logStatusText, mb } from "./copy";
import { VirtualLog } from "./VirtualLog";

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

export function LogPanel({ env, jobRef, job, line }: { env: Environment; jobRef: JobRef; job: Job; line?: number }) {
  const loader = useLoader(env, jobRef);
  return <LoadedLogPanel key={job.id} loader={loader} jobRef={jobRef} job={job} line={line} />;
}

function LoadedLogPanel({ loader, jobRef, job, line }: { loader: LogLoader; jobRef: JobRef; job: Job; line?: number }) {
  const snap = useSyncExternalStore(
    useCallback((onChange: () => void) => loader.subscribe(onChange), [loader]),
    () => loader.snapshot,
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ query: string; lines: number[]; capped: boolean; partial: boolean } | null>(null);
  const fetchRows = useCallback((from: number, n: number) => loader.rows("full", from, n), [loader]);
  const hrefFor = useCallback((n: number) => routeToHash({ run: jobRef, jobId: jobRef.jobId, line: n }), [jobRef]);
  const status = snap.status;
  const showFull = snap.lines > 0 && ["loading", "cancelled", "complete", "incomplete"].includes(status);
  const showTail = snap.tail !== undefined && status !== "complete";
  const searchable = showFull;

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const q = query;
    const result = await loader.search(q);
    if (result) setHits({ query: q, ...result, partial: loader.snapshot.status !== "complete" });
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
          <button onClick={() => void loader.loadFull()}>Load full log ({snap.bytesTotal !== undefined ? mb(snap.bytesTotal) : "?"}) for search and line navigation</button>
        )}
        {(status === "incomplete" || status === "processing-failed" || status === "failed") && <button onClick={() => void loader.retry()}>Retry</button>}
      </div>
      {status === "tail-only" && <p className="note">Large logs use memory roughly in proportion to their size.</p>}
      {snap.notice?.kind === "range-unsupported" && <p className="note">The log host ignored the byte range; downloading the whole log instead.</p>}

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

      {status === "tail-only" && <p className="note">Search: unavailable until the full log is loaded. Step boundaries: not shown yet.</p>}

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
              <a href={hrefFor(n + 1)}>Line {n + 1}</a>
            </li>
          ))}
        </ul>
      )}

      {showFull && <VirtualLog lineCount={snap.lines} fetchRows={fetchRows} highlight={line} hrefFor={hrefFor} />}
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
