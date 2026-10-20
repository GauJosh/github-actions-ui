import { useQuery } from "@tanstack/react-query";
import type { Environment } from "../app/environment";
import { routeToHash } from "../domain/run-url";
import { isNotSuccessful, type Job, type RunRef } from "../domain/types";
import { GitHubError } from "../github/client";
import { failureText } from "./copy";
import { LogPanel } from "./LogPanel";

function ErrorState({ error }: { error: unknown }) {
  const text = error instanceof GitHubError ? failureText(error.failure) : "Something went wrong loading this run.";
  return (
    <p className="state state-error" role="alert">
      {text}
    </p>
  );
}

export function RunView({ env, run: ref, jobId, line }: { env: Environment; run: RunRef; jobId?: number; line?: number }) {
  const key = [env.mode, ref.owner, ref.repo, ref.runId];
  const run = useQuery({ queryKey: ["run", ...key], queryFn: () => env.client.getRun(ref) });
  const jobs = useQuery({ queryKey: ["jobs", ...key], queryFn: () => env.client.getJobs(ref) });

  if (run.isPending || jobs.isPending) return <p className="state">Loading run…</p>;
  if (run.isError) return <ErrorState error={run.error} />;
  if (jobs.isError) return <ErrorState error={jobs.error} />;

  const all = jobs.data;
  const failed = all.filter(isNotSuccessful);
  const others = all.filter((j) => !isNotSuccessful(j));
  const selected: Job | undefined = all.find((j) => j.id === jobId) ?? failed[0];
  const r = run.data;

  return (
    <div className="run">
      <section className="panel">
        <header className="panel-head">
          <h2>{r.display_title}</h2>
          <a href={r.html_url} target="_blank" rel="noreferrer noopener">
            Open run on GitHub
          </a>
        </header>
        <p className="meta">
          <span className={`badge badge-${r.conclusion ?? r.status}`}>{r.conclusion ?? r.status}</span>
          <span>attempt {r.run_attempt}</span>
          {r.head_branch && <span>branch {r.head_branch}</span>}
          <span className="mono">{r.head_sha.slice(0, 7)}</span>
          <span>{r.event}</span>
        </p>
      </section>

      <section className="panel" aria-label="Jobs">
        <h3>{failed.length ? `Not successful (${failed.length})` : "No unsuccessful jobs in the latest attempt"}</h3>
        <ul className="jobs" data-testid="failed-jobs">
          {failed.map((job) => (
            <JobItem key={job.id} job={job} href={routeToHash({ run: ref, jobId: job.id })} selected={job.id === selected?.id} />
          ))}
        </ul>
        {others.length > 0 && (
          <details>
            <summary>Other jobs ({others.length})</summary>
            <ul className="jobs">
              {others.map((job) => (
                <JobItem key={job.id} job={job} href={routeToHash({ run: ref, jobId: job.id })} selected={job.id === selected?.id} />
              ))}
            </ul>
          </details>
        )}
      </section>

      {selected ? (
        <LogPanel env={env} jobRef={{ ...ref, jobId: selected.id }} job={selected} line={selected.id === jobId ? line : undefined} />
      ) : (
        <p className="state">Select a job to open its log.</p>
      )}
    </div>
  );
}

function JobItem({ job, href, selected }: { job: Job; href: string; selected: boolean }) {
  const failedSteps = (job.steps ?? []).filter(isNotSuccessful);
  return (
    <li className={selected ? "job selected" : "job"}>
      <a href={href}>
        <span className={`badge badge-${job.conclusion ?? job.status}`}>{job.conclusion ?? job.status}</span> {job.name}
      </a>
      {failedSteps.length > 0 && (
        <ul className="steps">
          {failedSteps.map((s) => (
            <li key={s.number}>
              Step {s.number}: {s.name} <span className="muted">({s.conclusion})</span>
            </li>
          ))}
        </ul>
      )}
      {job.steps && job.steps.length === 0 && <p className="muted">GitHub returned no step list for this job.</p>}
    </li>
  );
}
