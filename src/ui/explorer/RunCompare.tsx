// Run-to-run comparison view: this run (at its selected attempt) against a baseline run at an explicit attempt.
// A summary first, then drill-downs: jobs and their steps, commits, the workflow file, dependencies and
// environments. Each side is loaded on its own (see run-side.ts); differences link to the job, step, graph or log.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Environment } from "../../app/environment";
import { hunks } from "../../domain/compare/diff";
import { compareRuns, type DurationDiff, type JobDiff, type RunComparison, type Side } from "../../domain/compare/runs";
import { routeToHash } from "../../domain/run-url";
import type { Job, Run, RunRef, Step } from "../../domain/types";
import { GitHubError } from "../../github/client";
import { failureText } from "../copy";
import { absoluteTime, firstLine, formatDuration, relativeTime, shortSha } from "../format";
import { ErrorState } from "../RepoDashboard";
import { StatusBadge, StatusIcon, statusOf } from "../status";
import { LogCompare } from "./LogCompare";
import { useRunSide } from "./run-side";

type Base = { runId: number; attempt: number };

type Props = {
  env: Environment;
  runRef: RunRef;
  /** The run as GitHub reports it now (its latest attempt). */
  latest: Run;
  /** This side's attempt, explicit. */
  attempt: number;
  /** The attempt as the run's URL names it (absent for the latest), for links that stay in this run. */
  routeAttempt?: number;
  base?: Base;
  onSelectBase(base: Base | undefined): void;
  onSelectJob(job: Job): void;
  /** Links into this run (the head side). */
  graphHref(jobId: number): string;
  stepHref(job: Job, step: number): string;
};

export function RunCompare({ env, runRef, latest, attempt, routeAttempt, base, onSelectBase, onSelectJob, graphHref, stepHref }: Props) {
  const baseRef = useMemo(() => (base ? { owner: runRef.owner, repo: runRef.repo, runId: base.runId } : runRef), [base, runRef]);
  const head = useRunSide(env, runRef, attempt);
  const baseline = useRunSide(env, baseRef, base?.attempt);
  const comparison = useMemo(() => (head.side && baseline.side ? compareRuns(baseline.side, head.side) : null), [head.side, baseline.side]);

  if (!base) {
    return (
      <section className="compare" data-testid="compare">
        <header className="panel-head">
          <h3>Compare with another execution</h3>
        </header>
        <BasePicker env={env} runRef={runRef} latest={latest} attempt={attempt} onSelect={onSelectBase} />
      </section>
    );
  }
  return (
    <section className="compare" data-testid="compare">
      <header className="panel-head">
        <h3>Comparison</h3>
        <button type="button" onClick={() => onSelectBase(undefined)} data-testid="change-baseline">
          Change baseline
        </button>
      </header>
      <div className="compare-sides">
        <SideCard title="Baseline" testid="side-base" side={baseline.side} runRef={baseRef} error={baseline.error} loading={baseline.loading} />
        <span className="compare-arrow" aria-hidden="true">
          →
        </span>
        <SideCard title="This run" testid="side-head" side={head.side} runRef={runRef} error={head.error} loading={head.loading} />
      </div>
      {baseline.error && <ErrorState error={baseline.error} onRetry={baseline.refetch} />}
      {head.error && <ErrorState error={head.error} onRetry={head.refetch} />}
      {comparison && head.side && baseline.side && (
        <Details
          env={env}
          c={comparison}
          base={baseline.side}
          head={head.side}
          baseRef={baseRef}
          runRef={runRef}
          routeAttempt={routeAttempt}
          onSelectJob={onSelectJob}
          graphHref={graphHref}
          stepHref={stepHref}
        />
      )}
    </section>
  );
}

function SideCard({ title, testid, side, runRef, error, loading }: { title: string; testid: string; side: Side | null; runRef: RunRef; error: unknown; loading: boolean }) {
  const r = side?.run;
  return (
    <article className="compare-side" data-testid={testid} data-run={runRef.runId} data-attempt={side?.attempt}>
      <h4>{title}</h4>
      {loading && <p className="state">Loading…</p>}
      {Boolean(error) && <p className="state state-error">Could not be loaded.</p>}
      {r && side && (
        <>
          <p>
            <StatusBadge status={statusOf(r)} />{" "}
            <a href={routeToHash({ run: runRef, attempt: side.attempt, view: "graph" })}>
              Run #{r.run_number ?? r.id} · attempt {side.attempt}
            </a>
          </p>
          <dl className="compare-facts">
            <dt>Workflow</dt>
            <dd>
              {r.name ?? "—"} {r.path && <code>{r.path}</code>}
            </dd>
            <dt>Run ID</dt>
            <dd className="mono">{r.id}</dd>
            <dt>Commit</dt>
            <dd>
              <span className="mono">{shortSha(r.head_sha)}</span> {firstLine(r.head_commit?.message) && <span className="muted">{firstLine(r.head_commit?.message)}</span>}
            </dd>
            <dt>Branch</dt>
            <dd>
              {r.head_branch ?? "—"} <span className="chip">{r.event}</span>
            </dd>
            <dt>Started</dt>
            <dd>{r.run_started_at ? <time title={absoluteTime(r.run_started_at)}>{relativeTime(r.run_started_at)}</time> : "—"}</dd>
          </dl>
        </>
      )}
    </article>
  );
}

/** Other attempts of this run, and recent runs of the same workflow, with a suggested baseline. */
function BasePicker({ env, runRef, latest, attempt, onSelect }: { env: Environment; runRef: RunRef; latest: Run; attempt: number; onSelect(b: Base): void }) {
  const runs = useQuery({
    queryKey: ["compare-candidates", env.mode, runRef.owner, runRef.repo, latest.workflow_id ?? latest.path],
    queryFn: async () => {
      const page = await env.client.listRuns(runRef, latest.workflow_id ? { workflowId: latest.workflow_id } : {}, 1, 30);
      return page.runs.filter((r) => r.path === latest.path);
    },
    staleTime: 60_000,
  });
  const others = (runs.data ?? []).filter((r) => r.id !== latest.id);
  const created = latest.created_at ?? "";
  const earlier = others.filter((r) => (r.created_at ?? "") < created);
  const suggestion = earlier.find((r) => r.conclusion === "success" && r.head_branch === latest.head_branch) ?? earlier.find((r) => r.conclusion === "success");
  const attempts = Array.from({ length: latest.run_attempt }, (_, i) => i + 1).filter((n) => n !== attempt);
  return (
    <div className="compare-picker" data-testid="baseline-picker">
      {suggestion && (
        <p className="finding-ok">
          Suggested baseline: the previous successful run of this workflow{suggestion.head_branch === latest.head_branch ? ` on ${latest.head_branch}` : ""}.{" "}
          <button type="button" onClick={() => onSelect({ runId: suggestion.id, attempt: suggestion.run_attempt })} data-testid="use-suggested">
            Compare with run #{suggestion.run_number ?? suggestion.id} (attempt {suggestion.run_attempt})
          </button>
        </p>
      )}
      {attempts.length > 0 && (
        <>
          <h4>Other attempts of this run</h4>
          <ul className="overview-list">
            {attempts.map((n) => (
              <li key={n}>
                <button type="button" className="linklike" onClick={() => onSelect({ runId: runRef.runId, attempt: n })} data-testid="pick-attempt" data-attempt={n}>
                  Attempt {n}
                  {n === latest.run_attempt ? " (latest)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Runs of this workflow</h4>
      {runs.isPending && <p className="state">Loading runs…</p>}
      {runs.isError && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />}
      {runs.isSuccess && others.length === 0 && <p className="note">No other runs of this workflow were found in its 30 most recent runs.</p>}
      <ul className="overview-list">
        {others.map((r) => (
          <li key={r.id}>
            <button type="button" className="linklike" onClick={() => onSelect({ runId: r.id, attempt: r.run_attempt })} data-testid="pick-run" data-run={r.id}>
              <StatusIcon status={statusOf(r)} /> #{r.run_number ?? r.id} {r.display_title}
            </button>{" "}
            <span className="muted">
              {r.head_branch} · {shortSha(r.head_sha)} · {r.created_at ? relativeTime(r.created_at) : ""}
              {r.run_attempt > 1 ? ` · latest of ${r.run_attempt} attempts` : ""}
            </span>
          </li>
        ))}
      </ul>
      {latest.workflow_id === undefined && <p className="note">This run reports no workflow id, so runs are listed by workflow file path.</p>}
    </div>
  );
}

const CHANGE_TEXT = { outcome: "Outcome changed", added: "Only in this run", removed: "Only in the baseline", same: "Same outcome" } as const;
const BASIS_TEXT = { "workflow-file": "matched by workflow job id", name: "matched by name only", "possible-rename": "possibly renamed (not certain)" } as const;

function durationText(d: DurationDiff): string {
  if (!d.comparable) return d.why ? `not comparable: ${d.why}` : "";
  const sign = d.delta! > 0 ? "+" : d.delta! < 0 ? "−" : "±";
  const pct = d.ratio !== undefined && d.base ? ` (${sign}${Math.round(Math.abs(d.ratio - 1) * 100)}%)` : "";
  return `${formatDuration(d.base!)} → ${formatDuration(d.head!)}, ${sign}${formatDuration(Math.abs(d.delta!))}${pct}`;
}

function Details({
  env,
  c,
  base,
  head,
  baseRef,
  runRef,
  routeAttempt,
  onSelectJob,
  graphHref,
  stepHref,
}: {
  env: Environment;
  routeAttempt?: number;
  c: RunComparison;
  base: Side;
  head: Side;
  baseRef: RunRef;
  runRef: RunRef;
  onSelectJob(job: Job): void;
  graphHref(jobId: number): string;
  stepHref(job: Job, step: number): string;
}) {
  const [all, setAll] = useState(false);
  const [logPair, setLogPair] = useState<JobDiff | null>(null);
  const shown = all ? c.jobs : c.jobs.filter((j) => j.change !== "same" || j.duration.trend || j.renamed || j.steps.some((s) => s.change !== "same"));
  const baseHref = (job: Job, step?: number) => routeToHash({ run: baseRef, attempt: base.attempt, view: "graph", jobId: job.id, ...(step !== undefined && { step, log: true }) });
  return (
    <>
      {!c.comparable.ok && (
        <div className="state state-warn" role="note" data-testid="not-comparable">
          {c.comparable.reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </div>
      )}
      <ul className="compare-summary" data-testid="compare-summary">
        {c.summary.map((s) => (
          <li key={s}>{s}</li>
        ))}
        <li>
          Duration: {c.duration.comparable ? durationText(c.duration) : `not comparable (${c.duration.why})`}
          {c.duration.comparable && <span className="muted"> · from the first job start to the last job end</span>}
        </li>
      </ul>

      <section className="compare-section" aria-labelledby="cmp-jobs">
        <header className="compare-section-head">
          <h4 id="cmp-jobs">Jobs</h4>
          <label>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="show-all-jobs" /> Show unchanged jobs
          </label>
        </header>
        {shown.length === 0 ? (
          <p className="note">No job differs in outcome, steps or notable duration.</p>
        ) : (
          <table className="compare-jobs" data-testid="compare-jobs">
            <thead>
              <tr>
                <th>Job</th>
                <th>Baseline</th>
                <th>This run</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((j) => (
                <JobRow key={j.key} j={j} onSelectJob={onSelectJob} graphHref={graphHref} stepHref={stepHref} baseHref={baseHref} onCompareLogs={() => setLogPair(j)} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {logPair?.base && logPair.head && (
        <LogCompare
          key={`${logPair.base.id}:${logPair.head.id}`}
          env={env}
          label={logPair.label}
          base={{ ref: { ...baseRef, jobId: logPair.base.id }, job: logPair.base, attempt: base.attempt, href: (line) => routeToHash({ run: baseRef, attempt: base.attempt, view: "graph", jobId: logPair.base!.id, line }) }}
          head={{ ref: { ...runRef, jobId: logPair.head.id }, job: logPair.head, attempt: head.attempt, href: (line) => routeToHash({ run: runRef, attempt: routeAttempt, view: "compare", base: { runId: baseRef.runId, attempt: base.attempt }, jobId: logPair.head!.id, line }) }}
          uncertain={logPair.basis !== "workflow-file"}
          onClose={() => setLogPair(null)}
        />
      )}

      <Commits env={env} runRef={runRef} base={base.run} head={head.run} />
      <WorkflowSection c={c} base={base} head={head} />

      <section className="compare-section" aria-labelledby="cmp-graph" data-testid="compare-graph">
        <h4 id="cmp-graph">Dependencies</h4>
        {!c.graph.available ? (
          <p className="note">{c.graph.why}</p>
        ) : c.graph.addedJobs.length + c.graph.removedJobs.length + c.graph.addedEdges.length + c.graph.removedEdges.length === 0 ? (
          <p className="note">The same jobs and dependencies are declared in both workflow files.</p>
        ) : (
          <ul className="compare-list">
            {c.graph.addedJobs.map((k) => (
              <li key={`+${k}`}>
                <span className="diff-add">+ job</span> <code>{k}</code>
              </li>
            ))}
            {c.graph.removedJobs.map((k) => (
              <li key={`-${k}`}>
                <span className="diff-remove">− job</span> <code>{k}</code>
              </li>
            ))}
            {c.graph.addedEdges.map(([f, t]) => (
              <li key={`+${f}>${t}`}>
                <span className="diff-add">+ needs</span> <code>{t}</code> needs <code>{f}</code>
              </li>
            ))}
            {c.graph.removedEdges.map(([f, t]) => (
              <li key={`-${f}>${t}`}>
                <span className="diff-remove">− needs</span> <code>{t}</code> needed <code>{f}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {c.environments.length > 0 && (
        <section className="compare-section" aria-labelledby="cmp-env" data-testid="compare-environments">
          <h4 id="cmp-env">Environments</h4>
          <ul className="compare-list">
            {c.environments.map((e) => (
              <li key={e.environment}>
                <code>{e.environment}</code> {e.base ? <StatusIcon status={e.base} /> : <span className="muted">not in the baseline</span>} →{" "}
                {e.head ? <StatusIcon status={e.head} /> : <span className="muted">not in this run</span>} <span className="muted">{e.base === e.head ? "same" : `${e.base ?? "—"} → ${e.head ?? "—"}`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {c.notes.length > 0 && (
        <ul className="impact-notes" data-testid="compare-notes">
          {c.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function JobRow({
  j,
  onSelectJob,
  graphHref,
  stepHref,
  baseHref,
  onCompareLogs,
}: {
  j: JobDiff;
  onSelectJob(job: Job): void;
  graphHref(jobId: number): string;
  stepHref(job: Job, step: number): string;
  baseHref(job: Job, step?: number): string;
  onCompareLogs(): void;
}) {
  const stepChanges = j.steps.filter((s) => s.change !== "same");
  const failed = (s?: Step) => s && (s.conclusion === "failure" || s.conclusion === "timed_out");
  return (
    <>
      <tr data-testid="compare-job" data-key={j.key} data-change={j.change}>
        <td>
          <span className="compare-job-name">{j.label}</span>
          <span className="muted compare-basis"> · {BASIS_TEXT[j.basis]}</span>
          {j.renamed && (
            <span className="tag" title="Same job in the workflow file, different display name">
              renamed from {j.renamed.from}
            </span>
          )}
          <div className="compare-job-links">
            {j.head && (
              <>
                <button type="button" className="linklike" onClick={() => onSelectJob(j.head!)}>
                  details
                </button>
                <a href={graphHref(j.head.id)}>in graph</a>
              </>
            )}
            {j.base && <a href={baseHref(j.base)}>baseline job</a>}
            {j.base && j.head && (
              <button type="button" className="linklike" onClick={onCompareLogs} data-testid="compare-logs">
                compare logs
              </button>
            )}
          </div>
        </td>
        <td>{j.baseStatus ? <StatusIcon status={j.baseStatus} /> : <span className="muted">—</span>} {j.baseStatus && <span className="visually-hidden">{j.baseStatus}</span>}</td>
        <td>
          {j.headStatus ? <StatusIcon status={j.headStatus} /> : <span className="muted">—</span>} {j.headStatus && <span className="visually-hidden">{j.headStatus}</span>}{" "}
          <span className={`compare-change c-${j.change}`}>{CHANGE_TEXT[j.change]}</span>
        </td>
        <td className={j.duration.trend ? `trend-${j.duration.trend}` : "muted"} data-testid="compare-duration">
          {durationText(j.duration)}
        </td>
      </tr>
      {(stepChanges.length > 0 || j.notes.length > 0) && (
        <tr className="compare-sub">
          <td colSpan={4}>
            {stepChanges.length > 0 && (
              <ul className="compare-steps" data-testid="compare-steps">
                {stepChanges.map((s) => (
                  <li key={`${s.name}:${s.base?.number}:${s.head?.number}`}>
                    Step <q>{s.name}</q>:{" "}
                    {s.change === "added" ? "only in this run" : s.change === "removed" ? "only in the baseline" : `${s.base!.conclusion ?? s.base!.status} → ${s.head!.conclusion ?? s.head!.status}`}
                    {failed(s.head) && j.head && (
                      <>
                        {" "}
                        · <a href={stepHref(j.head, s.head!.number)}>this run&apos;s log at the step</a>
                      </>
                    )}
                    {failed(s.base) && j.base && (
                      <>
                        {" "}
                        · <a href={baseHref(j.base, s.base!.number)}>baseline log at the step</a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {j.notes.map((n) => (
              <p key={n} className="note">
                {n}
              </p>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function Commits({ env, runRef, base, head }: { env: Environment; runRef: RunRef; base: Run; head: Run }) {
  const same = base.head_sha === head.head_sha;
  const commits = useQuery({
    queryKey: ["compare-commits", env.mode, runRef.owner, runRef.repo, base.head_sha, head.head_sha],
    queryFn: () => env.client.compareCommits(runRef, base.head_sha, head.head_sha),
    enabled: !same,
    retry: false,
    staleTime: Infinity,
  });
  return (
    <section className="compare-section" aria-labelledby="cmp-commits" data-testid="compare-commits">
      <h4 id="cmp-commits">Commits</h4>
      {same ? (
        <p className="note">Both ran commit {shortSha(head.head_sha)}.</p>
      ) : commits.isPending ? (
        <p className="state">Comparing commits…</p>
      ) : commits.isError ? (
        <p className="note">
          The commits could not be compared ({commits.error instanceof GitHubError ? failureText(commits.error.failure) : "unexpected error"}). Baseline {shortSha(base.head_sha)}, this
          run {shortSha(head.head_sha)}.
        </p>
      ) : (
        <>
          <p>
            {commits.data.status === "behind"
              ? `This run's commit is ${commits.data.behind_by} commit${commits.data.behind_by === 1 ? "" : "s"} behind the baseline's.`
              : commits.data.status === "diverged"
                ? `The commits have diverged: ${commits.data.ahead_by} ahead and ${commits.data.behind_by} behind the baseline's.`
                : `${commits.data.ahead_by} commit${commits.data.ahead_by === 1 ? "" : "s"} from the baseline's commit to this run's.`}{" "}
            {commits.data.html_url && (
              <a href={commits.data.html_url} target="_blank" rel="noreferrer noopener">
                Open the comparison on GitHub
              </a>
            )}
          </p>
          {commits.data.commits.length > 0 && (
            <ul className="compare-list">
              {commits.data.commits.slice(0, 10).map((k) => (
                <li key={k.sha}>
                  <span className="mono">{shortSha(k.sha)}</span> {firstLine(k.commit.message)}
                </li>
              ))}
              {commits.data.total_commits > 10 && <li className="muted">and {commits.data.total_commits - 10} more</li>}
            </ul>
          )}
          <p className="note">A commit listed here is a difference between the two runs, not evidence that it caused a change in outcome.</p>
        </>
      )}
    </section>
  );
}

function WorkflowSection({ c, base, head }: { c: RunComparison; base: Side; head: Side }) {
  const w = c.workflow;
  const rows = useMemo(() => {
    if (!w.diff || "tooLarge" in w.diff) return null;
    const a = base.workflowText!.split("\n");
    const b = head.workflowText!.split("\n");
    const out: { kind: string; text: string; key: string }[] = [];
    for (const h of hunks(w.diff.ops, 2)) {
      out.push({ kind: "hunk", text: `@@ baseline ${h.a[0] + 1}–${h.a[1]} · this run ${h.b[0] + 1}–${h.b[1]}`, key: `h${h.a[0]}:${h.b[0]}` });
      for (const op of h.ops)
        for (let i = 0; i < op.length; i++) {
          const text = op.kind === "add" ? b[op.b + i]! : a[op.a + i]!;
          out.push({ kind: op.kind, text, key: `${op.kind}${op.a + i}:${op.b + i}` });
        }
    }
    return out.slice(0, 400);
  }, [w.diff, base.workflowText, head.workflowText]);
  return (
    <section className="compare-section" aria-labelledby="cmp-wf" data-testid="compare-workflow">
      <h4 id="cmp-wf">Workflow file</h4>
      <p>
        {w.file === "same"
          ? `The workflow file is the same at both commits.`
          : w.file === "changed"
            ? "The workflow file differs between the two commits."
            : "Whether the workflow file changed is unknown: it was not available for both runs."}
        {!w.samePath && " The runs use different workflow files."}
      </p>
      {w.diff && "tooLarge" in w.diff && <p className="note">The files differ in too many lines to show here.</p>}
      {rows && (
        <pre className="compare-diff" data-testid="workflow-diff">
          {rows.map((r) => (
            <span key={r.key} className={`dl d-${r.kind}`}>
              {r.kind === "add" ? "+ " : r.kind === "remove" ? "− " : r.kind === "hunk" ? "" : "  "}
              {r.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {w.called.length > 0 && (
        <ul className="compare-list" data-testid="compare-called">
          {w.called.map((x) => (
            <li key={x.path}>
              Called workflow <code>{x.path}</code>: {x.base ? shortSha(x.base) : "not called"} → {x.head ? shortSha(x.head) : "not called"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
