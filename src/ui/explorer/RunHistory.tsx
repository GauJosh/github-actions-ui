// History: recent runs of this run's workflow, their durations, this run against earlier successful runs, and the
// slowest jobs. Read-only: one runs listing, then each run's jobs at its own attempt, two at a time. A run whose jobs
// cannot be read is listed and left out; nothing missing is shown as zero, and no timing change is given a cause.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Environment } from "../../app/environment";
import { compareToBaseline, durationTrend, outcomes, rankJobs, runDuration, type HistoryRun, type Measure } from "../../domain/insights/history";
import { routeToHash } from "../../domain/run-url";
import type { Job, Run, RunRef } from "../../domain/types";
import { HISTORY_LIMITS, loadHistory } from "../../runs/history";
import { formatDuration } from "../format";
import { ErrorState } from "../RepoDashboard";
import { HistoryOverview } from "./HistoryOverview";
import { StatusBadge, statusOf } from "../status";

type Props = { env: Environment; runRef: RunRef; run: Run; attempt: number; jobs: Job[] };

const durationText = (d: Measure) => ("ms" in d ? formatDuration(d.ms) || "0s" : `not measured: ${d.unavailable}`);

export function RunHistory({ env, runRef, run, attempt, jobs }: Props) {
  const history = useQuery({
    queryKey: ["history", env.mode, runRef.owner, runRef.repo, run.workflow_id ?? run.path, run.id],
    // React Query aborts the signal when the view closes or the run changes; no further jobs requests start then.
    queryFn: ({ signal }) => loadHistory(env.client, runRef, run, signal),
    staleTime: 60_000,
  });
  // Earlier runs have no workflow file loaded, so jobs are matched by name everywhere, this run included.
  const target: HistoryRun = useMemo(() => ({ run, attempt, jobs, graph: null }), [run, attempt, jobs]);
  const model = useMemo(() => {
    if (!history.data) return null;
    const all = [target, ...history.data.runs];
    return { own: runDuration(target), trend: durationTrend(all), baseline: compareToBaseline(target, history.data.runs), ranking: rankJobs(all), outcomes: outcomes(history.data.runs, target.run) };
  }, [history.data, target]);

  if (history.isPending) return <p className="state">Loading the last {HISTORY_LIMITS.runs} runs of this workflow…</p>;
  if (history.isError) return <ErrorState error={history.error} onRetry={() => void history.refetch()} />;
  const { runs, failed, listed } = history.data;
  const { own, trend, baseline, ranking, outcomes: counts } = model!;
  const max = Math.max(1, ...trend.points.map((p) => ("ms" in p.duration ? p.duration.ms : 0)));
  const unmeasured = trend.points.filter((p) => "unavailable" in p.duration);
  const slowest = ranking.jobs.filter((j) => j.medianMs !== undefined).slice(0, 5);
  const href = (runId: number, n: number) => routeToHash({ run: { ...runRef, runId }, attempt: n, view: "graph" });

  return (
    <section className="history" data-testid="run-history">
      <HistoryOverview
        own={own}
        baseline={baseline}
        outcomes={counts}
        notLoaded={failed.length}
        trend={trend}
        isOwn={(p) => p.runId === run.id && p.attempt === attempt}
        href={(p) => href(p.runId, p.attempt)}
      />
      <p className="note" data-testid="history-count">
        {runs.length} earlier run{runs.length === 1 ? "" : "s"} loaded (of {listed} listed for this workflow; at most {HISTORY_LIMITS.runs}), each with the jobs of its own attempt.
        {" "}Jobs are matched by name: the workflow files of earlier runs are not loaded.
      </p>
      {failed.length > 0 && (
        <p className="state state-warn" data-testid="history-failed">
          The jobs of {failed.length} run{failed.length === 1 ? "" : "s"} could not be loaded and {failed.length === 1 ? "is" : "are"} left out: {failed.map((f) => `#${f.runId} (attempt ${f.attempt})`).join(", ")}.
        </p>
      )}

      <section className="compare-section" aria-labelledby="hist-baseline">
        <h4 id="hist-baseline">This run against earlier successful runs</h4>
        <div data-testid="history-baseline" data-kind={baseline.kind}>
          {baseline.kind === "measured" ? (
            <>
              <p>
                This run took <strong>{formatDuration(baseline.ms) || "0s"}</strong>; the median of {baseline.samples} earlier successful runs is{" "}
                <strong>{formatDuration(baseline.medianMs) || "0s"}</strong> (range {formatDuration(baseline.minMs) || "0s"}–{formatDuration(baseline.maxMs) || "0s"}).
              </p>
              <p>
                Difference: {baseline.deltaMs >= 0 ? "+" : "−"}
                {formatDuration(Math.abs(baseline.deltaMs)) || "0s"}
                {baseline.ratio !== undefined && ` (${Math.round(baseline.ratio * 100)}% of the median)`}. {baseline.faster} earlier run{baseline.faster === 1 ? " was" : "s were"} faster,{" "}
                {baseline.slower} slower.
              </p>
              {baseline.caveats.map((c) => (
                <p key={c} className="note">
                  {c}
                </p>
              ))}
            </>
          ) : baseline.kind === "insufficient" ? (
            <p className="state">Not enough history for a baseline: {baseline.why}</p>
          ) : (
            <p className="state">No baseline comparison: {baseline.why}</p>
          )}
        </div>
      </section>

      <section className="compare-section" aria-labelledby="hist-trend">
        <h4 id="hist-trend">Run durations (oldest first)</h4>
        <p className="note">From the first job start to the last job end of each attempt, including any time spent waiting for approvals.</p>
        <table className="compare-jobs history-trend" data-testid="history-trend">
          <thead>
            <tr>
              <th>Run</th>
              <th>Result</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {trend.points.map((p) => {
              const r = p.runId === run.id && p.attempt === attempt ? run : runs.find((x) => x.run.id === p.runId)?.run;
              const own = p.runId === run.id && p.attempt === attempt;
              return (
                <tr key={`${p.runId}.${p.attempt}`} data-testid="history-point" data-run={p.runId} data-attempt={p.attempt} data-measured={"ms" in p.duration} className={own ? "history-own" : undefined}>
                  <td>
                    {own ? <strong>this run</strong> : <a href={href(p.runId, p.attempt)}>#{p.runNumber ?? p.runId}</a>}
                    {p.attempt > 1 && <span className="muted"> · attempt {p.attempt}</span>}
                    {p.branch && <span className="muted"> · {p.branch}</span>}
                  </td>
                  <td>{r && <StatusBadge status={statusOf(r)} compact />}</td>
                  <td>
                    {"ms" in p.duration && <span className="history-bar" style={{ width: `calc(8rem * ${Math.max(0.02, p.duration.ms / max)})` }} aria-hidden="true" />}
                    <span className={"ms" in p.duration ? undefined : "muted"}>{durationText(p.duration)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {unmeasured.length > 0 && (
          <p className="note" data-testid="history-unmeasured">
            {unmeasured.length} run{unmeasured.length === 1 ? " has" : "s have"} no measurable duration and {unmeasured.length === 1 ? "is" : "are"} not part of any figure.
          </p>
        )}
      </section>

      <section className="compare-section" aria-labelledby="hist-jobs">
        <h4 id="hist-jobs">Slowest jobs</h4>
        <p className="note">Median duration over the runs where each job succeeded; runs where it failed or was cancelled stopped early and are counted apart.</p>
        {slowest.length === 0 ? (
          <p className="state">No job has a measured successful duration in these runs.</p>
        ) : (
          <table className="compare-jobs" data-testid="history-slowest">
            <thead>
              <tr>
                <th>Job</th>
                <th>Median</th>
                <th>Range</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              {slowest.map((j) => (
                <tr key={j.key} data-testid="history-job" data-key={j.key}>
                  <td>{j.label}</td>
                  <td>{formatDuration(j.medianMs) || "0s"}</td>
                  <td>
                    {formatDuration(j.minMs) || "0s"}–{formatDuration(j.maxMs) || "0s"}
                  </td>
                  <td>
                    {j.samples} succeeded{j.stoppedEarly > 0 && `, ${j.stoppedEarly} stopped early`}
                    {j.untimed > 0 && `, ${j.untimed} without timestamps`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ranking.notes.map((n) => (
          <p key={n} className="note">
            {n}
          </p>
        ))}
      </section>
    </section>
  );
}
