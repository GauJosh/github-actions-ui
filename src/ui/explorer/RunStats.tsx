// Run statistics: one run's duration, job counts, slowest and fastest jobs, critical path and deployments.
// Definitions are in src/domain/insights/stats.ts. Nothing here is historical.
import type { DeploymentRecord } from "../../domain/insights/deployments";
import { COUNT_ORDER, type RunStats as Stats, type TimedJob } from "../../domain/insights/stats";
import type { Job } from "../../domain/types";
import { formatDuration } from "../format";
import { durationMs } from "../../domain/graph/build";

const DEPLOY_GLYPH: Record<DeploymentRecord["outcome"], string> = {
  succeeded: "✓",
  failed: "✕",
  "rolled back": "↩",
  rejected: "⊘",
  running: "◐",
  skipped: "↷",
  "not started": "·",
};

type Props = {
  stats: Stats | null;
  /** Deployments of this run, or why they are not known yet. */
  deployments?: DeploymentRecord[];
  /** Still loading the workflow and dependency data (counts and durations are available before it). */
  graphPending: boolean;
  onSelectJob(job: Job): void;
};

function JobLink({ t, onSelectJob }: { t: TimedJob; onSelectJob(job: Job): void }) {
  return (
    <button type="button" className="linklike" onClick={() => onSelectJob(t.job)} title={`${t.job.name}: ${formatDuration(t.ms)}`}>
      {t.job.name} <span className="muted">{formatDuration(t.ms)}</span>
    </button>
  );
}

export function RunStats({ stats, deployments, graphPending, onSelectJob }: Props) {
  if (!stats) return <p className="run-stats state" data-testid="run-stats">Loading run statistics…</p>;
  const cp = stats.criticalPath;
  return (
    <section className="run-stats" aria-label="Run statistics" data-testid="run-stats">
      <dl className="stat-grid">
        <div>
          <dt title="From the first job's start to the last job's completion">Duration</dt>
          <dd data-testid="stat-duration">
            {stats.wallClock ? (
              <>
                {formatDuration(stats.wallClock.ms)}
                {stats.wallClock.partial && <span className="muted"> so far (still running)</span>}
              </>
            ) : (
              <span className="muted">no job has started</span>
            )}
          </dd>
        </div>
        <div>
          <dt title="Sum of every timed job's duration (machine time); parallel jobs make it longer than the duration">Job time</dt>
          <dd data-testid="stat-job-time">
            {stats.timed ? formatDuration(stats.summedMs) : <span className="muted">none timed</span>}
            {stats.timed > 0 && <span className="muted"> · {stats.timed} timed jobs</span>}
          </dd>
        </div>
        <div>
          <dt title="Longest chain of job durations through `needs`; excludes waiting between jobs (queues, approvals)">Critical path</dt>
          <dd data-testid="stat-critical-path">
            {graphPending ? (
              <span className="muted">reading dependencies…</span>
            ) : "ms" in cp ? (
              <>
                {formatDuration(cp.ms)} <span className="muted">· {cp.jobs} job{cp.jobs === 1 ? "" : "s"} in the chain</span>
              </>
            ) : (
              <span className="muted" title={cp.unavailable}>
                unavailable
              </span>
            )}
          </dd>
        </div>
        <div className="stat-counts">
          <dt>Jobs</dt>
          <dd data-testid="stat-counts">
            {stats.total}:{" "}
            {COUNT_ORDER.filter((b) => stats.counts[b])
              .map((b) => `${stats.counts[b]} ${b}`)
              .join(" · ")}
          </dd>
        </div>
      </dl>
      {stats.timed > 1 && (
        <p className="stat-line" data-testid="stat-slowest">
          <span className="stat-label">Slowest</span>
          {stats.slowest.map((t) => (
            <JobLink key={t.job.id} t={t} onSelectJob={onSelectJob} />
          ))}
          <span className="stat-label">Fastest</span>
          {stats.fastest.map((t) => (
            <JobLink key={t.job.id} t={t} onSelectJob={onSelectJob} />
          ))}
        </p>
      )}
      {deployments && deployments.length > 0 && (
        <p className="stat-line" data-testid="stat-deployments">
          <span className="stat-label" title="Jobs with an `environment:` (declared or passed by a caller) in this run. One run is not a deployment frequency or failure rate.">
            Deployments in this run
          </span>
          {deployments.map((d) => {
            const ms = durationMs(d.startedAt, d.completedAt);
            return (
              <span key={d.environment} className={`deploy-chip d-${d.outcome.replace(" ", "-")}`} data-environment={d.environment}>
                {DEPLOY_GLYPH[d.outcome]} {d.environment} · {d.outcome}
                {ms !== undefined ? ` · ${formatDuration(ms)}` : ""}
              </span>
            );
          })}
        </p>
      )}
      {(stats.missingTiming > 0 || ("unavailable" in cp && !graphPending)) && (
        <p className="note stat-notes" data-testid="stat-notes">
          {stats.missingTiming > 0 && `${stats.missingTiming} completed job${stats.missingTiming === 1 ? " has" : "s have"} no timestamps and ${stats.missingTiming === 1 ? "is" : "are"} left out of durations and rankings (not counted as zero). `}
          {"unavailable" in cp && !graphPending && `Critical path: ${cp.unavailable}`}
        </p>
      )}
    </section>
  );
}
