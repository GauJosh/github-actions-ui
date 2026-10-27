// Retries and recurrence: every attempt of this run, loaded on request, and optionally the recent runs of its workflow,
// read through the retry evidence model (domain/insights/retry-evidence.ts). Read-only: the run's attempts and their
// jobs (runs/attempts.ts), and the History view's run listing (shared query). No logs, artifacts, deployments or
// releases. Matching and outcomes come from the model; this view only arranges its facts, findings and notes.
//
// The evidence is about the whole run, not the attempt on screen: switching attempts keeps it, and says which attempt
// is viewed. A new run, or a new attempt of this run, starts again from "not loaded" (the parent keys this section).
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Environment } from "../../app/environment";
import { RECOVERY_CAVEAT, retryEvidence, type CrossRunJob, type JobObservation, type JobRetryEvidence, type RetryEvidence, type RunJobObservation } from "../../domain/insights/retry-evidence";
import type { Run, RunRef } from "../../domain/types";
import { ATTEMPT_LIMITS, AttemptDiscoveryError, loadAttempts, retryInput, type LoadedAttempt, type LoadedAttempts } from "../../runs/attempts";
import { HISTORY_LIMITS, loadHistory } from "../../runs/history";
import { graphFor, type DefinitionResult } from "../../runs/workflow-graph";
import { ErrorState } from "../RepoDashboard";

type Props = { env: Environment; runRef: RunRef; latest: Run; viewedAttempt?: number; definition?: DefinitionResult };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "attempt 2", "attempts 1 and 3", "attempts 1, 2 and 3". */
const numbered = (word: string, values: (string | number)[]) =>
  `${word}${values.length === 1 ? "" : "s"} ${values.length > 1 ? `${values.slice(0, -1).join(", ")} and ${values.at(-1)}` : values.join("")}`;
const time = (iso: string) => iso.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");
const NAME_ONLY = "matched by name only";

export function RunRetries({ env, runRef, latest, viewedAttempt, definition }: Props) {
  const [requested, setRequested] = useState(false);
  const [historyRequested, setHistoryRequested] = useState(false);
  const attempts = useQuery({
    queryKey: ["retry-attempts", env.mode, runRef.owner, runRef.repo, latest.id, latest.run_attempt, latest.status],
    // Aborted when the run changes or the view closes: no further request starts, and a partial result is dropped.
    queryFn: async ({ signal }) => {
      const loaded = await loadAttempts(env.client, { owner: runRef.owner, repo: runRef.repo, runId: latest.id }, latest, signal);
      if (loaded.cancelled) throw new DOMException("Loading attempts was cancelled", "AbortError");
      return loaded;
    },
    enabled: requested,
    // A failure is shown with "Try again"; nothing is requested again on its own.
    retry: false,
    staleTime: 60_000,
  });
  const history = useQuery({
    // The History view's query (same key and loader), so a history already loaded there is reused, not fetched again.
    queryKey: ["history", env.mode, runRef.owner, runRef.repo, latest.workflow_id ?? latest.path, latest.id],
    queryFn: ({ signal }) => loadHistory(env.client, runRef, latest, signal),
    enabled: requested && historyRequested,
    retry: false,
    staleTime: 60_000,
  });

  const loaded = attempts.data && !attempts.data.cancelled ? attempts.data : null;
  const evidence = useMemo(() => {
    if (!loaded) return null;
    const def = definition && "definition" in definition ? definition : null;
    // The workflow file read at this run's commit gives each attempt's jobs their workflow identity.
    const graphOf = (a: LoadedAttempt) => (def && def.file.revision === a.run.head_sha ? graphFor({ owner: runRef.owner, repo: runRef.repo }, a.run, a.jobs, def) : null);
    const h = history.data ? { runs: history.data.runs, failed: history.data.failed, listed: history.data.listed, limit: HISTORY_LIMITS.runs } : null;
    return retryEvidence(retryInput(loaded, { history: h, graphOf }));
  }, [loaded, history.data, definition, runRef.owner, runRef.repo]);

  return (
    <section className="compare-section run-retries" aria-labelledby="run-retries-title" data-testid="run-retries">
      <div className="compare-section-head">
        <h4 id="run-retries-title">Retries and recurrence</h4>
        {!requested && (
          <button type="button" onClick={() => setRequested(true)} data-testid="load-retries">
            Load attempts
          </button>
        )}
      </div>
      {!requested ? (
        <p className="note" data-testid="retries-state" data-state="not loaded">
          Reads every attempt of this run (the latest {ATTEMPT_LIMITS.attempts} at most) and each attempt&apos;s jobs, to show which failed jobs succeeded when run again and which failed in every attempt.
          No logs are read. Nothing is loaded until you ask.
        </p>
      ) : attempts.isPending ? (
        <p className="state" data-testid="retries-state" data-state="loading">
          Loading {plural(Math.min(latest.run_attempt, ATTEMPT_LIMITS.attempts), "attempt")} of this run…
        </p>
      ) : attempts.isError ? (
        <div data-testid="retries-state" data-state="error">
          {attempts.error instanceof AttemptDiscoveryError ? (
            <div className="state state-error" role="alert">
              <p>{attempts.error.message}</p>
              <button onClick={() => void attempts.refetch()}>Try again</button>
            </div>
          ) : (
            <ErrorState error={attempts.error} onRetry={() => void attempts.refetch()} />
          )}
          <p className="note">The attempts are unavailable, not absent: no partial evidence is shown.</p>
        </div>
      ) : loaded && evidence ? (
        <Evidence
          e={evidence}
          loaded={loaded}
          latest={latest}
          viewedAttempt={viewedAttempt ?? latest.run_attempt}
          history={history.data ? "loaded" : !historyRequested ? "not loaded" : history.isError ? "error" : "loading"}
          historyError={history.error}
          onLoadHistory={() => (historyRequested ? void history.refetch() : setHistoryRequested(true))}
        />
      ) : null}
    </section>
  );
}

type EvidenceProps = {
  e: RetryEvidence;
  loaded: Extract<LoadedAttempts, { cancelled: false }>;
  latest: Run;
  viewedAttempt: number;
  history: "not loaded" | "loading" | "error" | "loaded";
  historyError: unknown;
  onLoadHistory: () => void;
};

function Evidence({ e, loaded, latest, viewedAttempt, history, historyError, onLoadHistory }: EvidenceProps) {
  const within = e.jobs.filter((j) => j.findings.length > 0);
  const across = e.acrossRuns.jobs.filter((j) => j.findings.some((f) => f.kind !== "insufficient evidence"));
  const nameOnly = e.jobs.filter((j) => j.identity.basis === "name").map((j) => `“${j.identity.label}”`);
  // Jobs GitHub lists in an attempt but reports as run in another one: counted once, where GitHub says they ran.
  const carried = loaded.attempts.reduce((n, a) => n + a.jobs.filter((j) => j.run_attempt !== undefined && j.run_attempt !== a.attempt).length, 0);
  const historyLoaded = e.acrossRuns.history === "loaded";
  const earlier = e.acrossRuns.runsCompared.filter((id) => id !== e.runId).length;
  const findingCount = within.length + across.length;

  return (
    <div className="retries" data-testid="retries-evidence" data-run={e.runId} data-state={e.attemptsMissing.length ? "incomplete" : "complete"} data-findings={findingCount}>
      <div className="retries-block" data-testid="retries-coverage">
        <h5>Coverage</h5>
        <ul className="retries-list">
          <li data-testid="retries-attempts">
            Read {e.attemptsRead.length} of {plural(loaded.latestAttempt, "attempt")} of run {e.runId}{e.attemptsRead.length ? ` (${numbered("attempt", e.attemptsRead)})` : ""}.
            {e.attemptsMissing.length > 0 && <strong> Not read: {numbered("attempt", e.attemptsMissing.map((m) => m.attempt))}; what happened in {e.attemptsMissing.length === 1 ? "it" : "them"} is unknown, not a success.</strong>}
          </li>
          {latest.run_attempt > 1 && (
            <li data-testid="retries-viewed">
              You are viewing attempt {viewedAttempt} of {latest.run_attempt}. These findings cover every attempt read, not only the one on screen.
            </li>
          )}
          <li data-testid="retries-matching">
            {nameOnly.length === 0
              ? "Within this run, jobs are matched between attempts by their identity in the workflow file."
              : `Within this run, ${nameOnly.join(", ")} ${nameOnly.length === 1 ? "is" : "are"} ${NAME_ONLY}: weaker evidence than the workflow file's identity, since a renamed or duplicated job cannot be told apart.`}
          </li>
          <li data-testid="retries-history" data-state={history === "loaded" ? (earlier ? "loaded" : "loaded, none") : history}>
            {history === "not loaded" ? (
              <>
                History not loaded: how these jobs did in other runs of this workflow is unknown.{" "}
                <button type="button" className="linklike" onClick={onLoadHistory} data-testid="load-retry-history">
                  Load history (up to {HISTORY_LIMITS.runs} earlier runs)
                </button>
              </>
            ) : history === "loading" ? (
              "Loading the history of this workflow…"
            ) : history === "error" ? (
              <>
                <ErrorState error={historyError} onRetry={onLoadHistory} />
                History unavailable: other runs are unknown, not absent.
              </>
            ) : earlier === 0 ? (
              "History loaded: there are no earlier runs of this workflow to compare with."
            ) : (
              <>
                Compared with {plural(earlier, "earlier run")} of this workflow (GitHub listed {e.acrossRuns.listed}; at most {e.acrossRuns.limit} are loaded): a limited window, not every run. Each earlier run is
                represented by its latest attempt only;{" "}
                {e.acrossRuns.target.included ? `this run by its latest attempt (${e.acrossRuns.target.attempt}), so its earlier failed attempts do not make it count as failed.` : `this run is not counted (${e.acrossRuns.target.why}).`}
                {e.acrossRuns.basis === "name" && ` Across runs, jobs are ${NAME_ONLY} (weaker evidence than the workflow file's identity).`}
              </>
            )}
          </li>
          {carried > 0 && (
            <li data-testid="retries-carried">
              GitHub lists {plural(carried, "job")} in a later attempt as run in an earlier attempt (for example, a job that was not re-run). Each is counted once, in the attempt GitHub reports it ran in, and is never
              treated as run again. How GitHub lists such jobs has not been verified against live runs.
            </li>
          )}
          <li data-testid="retries-caveat">
            {RECOVERY_CAVEAT} These are job results, not test results, and they name no cause.
          </li>
        </ul>
      </div>

      <div className="retries-block" data-testid="retries-within">
        <h5>Retries within this run</h5>
        {within.length === 0 ? (
          <p className="note" data-testid="retries-within-none">
            No job failed and then succeeded on a later attempt, or failed in more than one attempt read.
          </p>
        ) : (
          <ul className="retries-list">
            {within.map((j) => (
              <WithinFinding key={j.identity.key} job={j} />
            ))}
          </ul>
        )}
      </div>

      <div className="retries-block" data-testid="retries-across">
        <h5>Across runs of this workflow</h5>
        {!historyLoaded ? (
          <p className="note">Not compared: history is not loaded. Retries in this run are not a recurrence across runs.</p>
        ) : across.length === 0 ? (
          <p className="note" data-testid="retries-across-none">
            No job failed in two or more of the runs compared, or both failed and succeeded in them.
          </p>
        ) : (
          <ul className="retries-list">
            {across.map((j) => (
              <AcrossFinding key={j.identity.key} job={j} compared={e.acrossRuns.runsCompared.length} />
            ))}
          </ul>
        )}
      </div>

      <details className="retries-block" data-testid="retries-observations">
        <summary>Observations (as GitHub reported them)</summary>
        <div className="retries-table-wrap">
          <table className="compare-jobs" data-testid="retries-within-table">
            <caption>Jobs of this run, by attempt</caption>
            <thead>
              <tr>
                <th>Job</th>
                <th>Attempt</th>
                <th>Job id</th>
                <th>GitHub conclusion</th>
                <th>Counted as</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {e.jobs.flatMap((j) => j.observations.map((o) => <WithinRow key={o.jobId} job={j} o={o} />))}
            </tbody>
          </table>
        </div>
        {historyLoaded && (
          <div className="retries-table-wrap">
            <table className="compare-jobs" data-testid="retries-across-table">
              <caption>Jobs of the runs compared, each run at its latest attempt</caption>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Run</th>
                  <th>Branch · event</th>
                  <th>Commit</th>
                  <th>GitHub conclusion</th>
                  <th>Counted as</th>
                </tr>
              </thead>
              <tbody>
                {e.acrossRuns.jobs.flatMap((j) => j.observations.map((o) => <AcrossRow key={`${o.runId}-${o.jobId}`} job={j} o={o} />))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <Limitations e={e} />
    </div>
  );
}

function Basis({ basis }: { basis: "workflow-file" | "name" }) {
  return basis === "name" ? <span className="retries-basis" data-testid="retries-name-only"> ({NAME_ONLY})</span> : null;
}

function WithinFinding({ job }: { job: JobRetryEvidence }) {
  return (
    <>
      {job.findings.map((f) => (
        <li key={f.kind} data-testid="retry-finding" data-kind={f.kind} data-job={job.identity.label}>
          <strong>{job.identity.label}</strong>
          <Basis basis={job.identity.basis} />:{" "}
          {f.kind === "recovered on retry" ? (
            <>
              recovered on retry. It failed in attempt {f.failed.ranInAttempt} ({f.failed.conclusion}, job {f.failed.jobId}) and succeeded when run again in attempt {f.succeeded.ranInAttempt} (job {f.succeeded.jobId}). Not
              by itself evidence of flakiness or of why it failed.
            </>
          ) : f.kind === "failed in every attempt observed" ? (
            <>failed in every attempt read ({numbered("attempt", f.attempts)}). These are retries of one run, not a recurrence across runs.</>
          ) : (
            <>insufficient evidence: {f.reasons.join(" ")}</>
          )}
          {f.kind !== "insufficient evidence" && job.notes.filter((n) => !n.startsWith("Matched")).map((n) => <span key={n}> {n}</span>)}
        </li>
      ))}
    </>
  );
}

function AcrossFinding({ job, compared }: { job: CrossRunJob; compared: number }) {
  return (
    <>
      {job.findings.map((f) =>
        f.kind === "insufficient evidence" ? null : (
          <li key={f.kind} data-testid="recurrence-finding" data-kind={f.kind} data-job={job.identity.label}>
            <strong>{job.identity.label}</strong>
            <Basis basis={job.identity.basis} />:{" "}
            {f.kind === "recurring failure" ? (
              <>
                failed in {f.failedRunIds.length} of the {plural(compared, "run")} compared ({numbered("run", f.failedRunIds)}; it appears in {plural(f.runsObserved, "run")}).
              </>
            ) : (
              <>
                mixed outcomes: failed in {numbered("run", f.failedRunIds)} and succeeded in {numbered("run", f.succeededRunIds)}.{" "}
                {f.sameCommit ? `The same commit (${f.commitsWithBoth.map((c) => c.slice(0, 7)).join(", ")}) has both outcomes.` : "No commit has both outcomes: the runs are at different commits."}
              </>
            )}
          </li>
        ),
      )}
    </>
  );
}

function WithinRow({ job, o }: { job: JobRetryEvidence; o: JobObservation }) {
  return (
    <tr data-testid="retry-observation" data-job-id={o.jobId} data-attempt={o.ranInAttempt ?? "unknown"} data-outcome={o.outcome}>
      <td>
        {job.identity.label}
        <Basis basis={job.identity.basis} />
      </td>
      <td>
        {o.ranInAttempt ?? "unknown"}
        {o.ranInAttempt !== o.listedInAttempt && <div className="muted">listed in attempt {o.listedInAttempt}</div>}
      </td>
      <td>{o.jobId}</td>
      <td>{o.conclusion ?? o.status}</td>
      <td>{o.outcome === "other" ? "neither" : o.outcome}</td>
      <td>{o.completedAt ? time(o.completedAt) : "—"}</td>
    </tr>
  );
}

function AcrossRow({ job, o }: { job: CrossRunJob; o: RunJobObservation }) {
  return (
    <tr data-testid="recurrence-observation" data-run={o.runId} data-job-id={o.jobId} data-outcome={o.outcome}>
      <td>
        {job.identity.label}
        <Basis basis={job.identity.basis} />
      </td>
      <td>
        {o.target ? <strong>this run</strong> : `run ${o.runId}`}
        <div className="muted">
          attempt {o.attempt}
          {o.runNumber !== undefined && ` · #${o.runNumber}`}
        </div>
      </td>
      <td>
        {o.branch ?? "no branch"} · {o.event}
      </td>
      <td>{o.commit.slice(0, 7)}</td>
      <td>{o.conclusion ?? o.status}</td>
      <td>{o.outcome === "other" ? "neither" : o.outcome}</td>
    </tr>
  );
}

function Limitations({ e }: { e: RetryEvidence }) {
  const historyLoaded = e.acrossRuns.history === "loaded";
  const items: string[] = [
    ...e.attemptsMissing.map((m) => `Attempt ${m.attempt} was not read (${m.why}).`),
    ...e.notes.filter((n) => !n.startsWith("Not read:")),
    ...(historyLoaded ? e.acrossRuns.notes : []),
    ...e.acrossRuns.excluded.map((x) => `Run ${x.runId} (attempt ${x.attempt}) is not compared: ${x.why}.`),
    ...(historyLoaded ? e.acrossRuns.jobs.flatMap((j) => j.findings.flatMap((f) => (f.kind === "insufficient evidence" ? [`${j.identity.label} across runs: ${f.reasons.join(" ")}`] : []))) : []),
  ];
  const unique = [...new Set(items)];
  return (
    <div className="retries-block" data-testid="retries-limitations">
      <h5>What is missing or uncertain</h5>
      {unique.length === 0 ? (
        <p className="note">Nothing was left out of the attempts read.</p>
      ) : (
        <ul className="retries-list">
          {unique.map((t) => (
            <li key={t} data-testid="retries-limitation">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
