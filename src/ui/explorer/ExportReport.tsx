// Export of an investigation report (domain/report): a preview of every section's state, then a validated JSON file
// saved on this computer. Built only from what this page already holds (the run, the attempt on screen, its jobs and
// failure impact, an open comparison, and the deployments, releases and artifacts sections the user loaded); nothing
// is requested to make it, and nothing is uploaded or kept after the preview closes.
//
// Deployments, releases and artifacts are read from the query cache only while their section on this page has
// loaded them (an active query): a cached result the page no longer shows is not included.
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Environment } from "../../app/environment";
import { compareRuns } from "../../domain/compare/runs";
import { artifactEvidence } from "../../domain/insights/artifacts";
import type { Impact } from "../../domain/insights/impact";
import { releaseEvidence } from "../../domain/insights/release-evidence";
import { buildReport, MASK, NO_CAUSE_NOTE, reportFilename, validateReport, type ExcerptInput, type InvestigationReport, type Loaded, type ReportInput, type SectionState } from "../../domain/report/report";
import type { Job, Run, RunRef } from "../../domain/types";
import type { LoadedArtifacts } from "../../runs/artifacts";
import type { LoadedDeployments } from "../../runs/deployments";
import type { LoadedReleases } from "../../runs/releases";
import { useRunSide } from "./run-side";

type Comparison = NonNullable<ReportInput["comparison"]>;

/**
 * The comparison open on the compare view, for the report. It shares its queries with the compare view, so it
 * requests nothing that view does not; on any other view it is disabled.
 */
export function useReportComparison(env: Environment, ref: RunRef, headAttempt: number | undefined, base: { runId: number; attempt: number } | undefined): Comparison {
  const baseRef = useMemo(() => (base ? { owner: ref.owner, repo: ref.repo, runId: base.runId } : ref), [base, ref]);
  const head = useRunSide(env, ref, base ? headAttempt : undefined);
  const baseline = useRunSide(env, baseRef, base?.attempt);
  return useMemo((): Comparison => {
    if (!base) return { state: "not loaded" };
    const error = baseline.error ?? head.error;
    if (error) return { state: "unavailable", reason: message(error) };
    if (!head.side || !baseline.side) return { state: "unavailable", reason: "The comparison was still loading." };
    return { state: "loaded", value: { base: baseline.side.run, baseAttempt: base.attempt, comparison: compareRuns(baseline.side, head.side) } };
  }, [base, head.side, head.error, baseline.side, baseline.error]);
}

type Props = {
  env: Environment;
  runRef: RunRef;
  /** The run as GitHub reports it now (its latest attempt). */
  latest: Run;
  /** The attempt in the URL and its own run data; absent for the latest attempt. */
  viewed?: { number: number; run: Run };
  jobs: Loaded<Job[]>;
  impact: Loaded<Impact>;
  comparison: Comparison;
  /** Log excerpts the user added for this run and attempt, in the order added. */
  excerpts: ExcerptInput[];
  onRemoveExcerpt(index: number): void;
  onClose(): void;
};

const SECTIONS: { key: "failures" | "comparison" | "logExcerpts" | "deployments" | "releases" | "artifacts"; label: string; notLoaded: string }[] = [
  { key: "failures", label: "Failed jobs and failure impact", notLoaded: "The jobs of this attempt had not loaded." },
  { key: "comparison", label: "Comparison with another execution", notLoaded: "No comparison is open. Compare with another execution, then export again to include it." },
  { key: "logExcerpts", label: "Log excerpts", notLoaded: "" },
  { key: "deployments", label: "Deployments of the commit", notLoaded: "Not loaded on this page. Load deployments below, then export again to include them." },
  { key: "releases", label: "Releases of the commit", notLoaded: "Not loaded on this page. Load releases below, then export again to include them." },
  { key: "artifacts", label: "Artifacts of the run", notLoaded: "Not loaded on this page. Load artifacts below, then export again to include them." },
];

const STATE: Record<SectionState, string> = { included: "Included", partial: "Partial", "not loaded": "Not loaded", unavailable: "Unavailable", "not applicable": "Not applicable" };

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : "Loading failed.");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A query whose section on this page currently loads it (an enabled observer), with what it holds. */
function active<T>(client: QueryClient, queryKey: readonly unknown[]): Query<T> | undefined {
  const q = client.getQueryCache().find<T>({ queryKey, exact: true });
  return q?.isActive() ? q : undefined;
}

/** Deployments, releases and artifacts as the page holds them now; never fetched here. */
function cachedEvidence(client: QueryClient, env: Environment, ref: RunRef, latest: Run, shown: Run, viewedAttempt?: number) {
  const repo = { owner: ref.owner, repo: ref.repo };
  const dq = active<LoadedDeployments>(client, ["deployments", env.mode, ref.owner, ref.repo, shown.id, shown.head_sha]);
  const loadedDeployments = dq?.state.status === "success" ? dq.state.data : undefined;
  const deployments: ReportInput["deployments"] = !dq
    ? { state: "not loaded" }
    : dq.state.status === "error"
      ? { state: "unavailable", reason: message(dq.state.error) }
      : !loadedDeployments
        ? { state: "unavailable", reason: "Deployments were still loading." }
        : (() => {
            const d = loadedDeployments;
            const e = releaseEvidence({ repo, run: shown, deployments: d.deployments });
            const missing = [
              d.moreDeployments && "GitHub lists more deployments of this commit than the first page that was read.",
              d.failed.length > 0 && `The statuses of ${plural(d.failed.length, "deployment")} could not be read.`,
              d.moreStatuses.length > 0 && `${plural(d.moreStatuses.length, "deployment")} had more statuses than the first page that was read.`,
              d.malformed > 0 && `${plural(d.malformed, "malformed deployment record")} left out.`,
            ].filter((m): m is string => Boolean(m));
            return { state: "loaded", value: { deployments: e.deployments, otherCommits: e.otherCommits, notes: e.notes }, missing };
          })();

  // Releases are checked in steps (one query per check); the page shows the latest check, or the one before it while
  // the next loads or after it failed.
  const prefix = ["releases", env.mode, ref.owner, ref.repo, shown.id, shown.head_sha];
  const rq = client.getQueryCache().findAll({ queryKey: prefix }).find((q) => q.isActive()) as Query<LoadedReleases> | undefined;
  const check = rq ? Number(rq.queryKey[prefix.length]) : 0;
  const earlier = check > 1 ? client.getQueryData<LoadedReleases>([...prefix, check - 1]) : undefined;
  const r = rq?.state.status === "success" ? rq.state.data : earlier;
  const releases: ReportInput["releases"] = !rq
    ? { state: "not loaded" }
    : !r
      ? { state: "unavailable", reason: rq.state.status === "error" ? message(rq.state.error) : "Releases were still loading." }
      : (() => {
          const e = releaseEvidence({ repo, run: shown, deployments: loadedDeployments?.deployments ?? null, releases: r.releases });
          const missing = [
            rq.state.status === "error" && `The last release check failed: ${message(rq.state.error)}`,
            rq.state.status === "pending" && "A further release check was still loading.",
            r.unresolved > 0 && `The tags of ${plural(r.unresolved, "listed release")} were not looked up.`,
            r.moreReleases && "GitHub lists older releases that were not read.",
            r.failed.length > 0 && `Tag lookups failed for ${plural(r.failed.length, "release")}.`,
          ].filter((m): m is string => Boolean(m));
          return { state: "loaded", value: { releases: e.releases, malformedReleases: e.malformedReleases, notes: e.notes }, missing };
        })();

  const aq = active<LoadedArtifacts>(client, ["artifacts", env.mode, ref.owner, ref.repo, latest.id, latest.run_attempt, latest.status]);
  const artifacts: ReportInput["artifacts"] = !aq
    ? { state: "not loaded" }
    : aq.state.status === "error"
      ? { state: "unavailable", reason: message(aq.state.error) }
      : aq.state.status !== "success"
        ? { state: "unavailable", reason: "Artifacts were still loading." }
        : { state: "loaded", value: artifactEvidence({ run: latest, viewedAttempt, listing: aq.state.data ?? null }) };
  return { deployments, releases, artifacts };
}

type Built = { report: InvestigationReport; errors: string[] } | { failed: string };

function summary(report: InvestigationReport, key: (typeof SECTIONS)[number]["key"]): string | undefined {
  switch (key) {
    case "failures":
      return report.failures.data && `${plural(report.failures.data.jobs.length, "failed job")}${report.failures.data.impact ? `; impact of ${plural(report.failures.data.impact.failures.length, "failure")}` : ""}.`;
    case "comparison":
      return report.comparison.data && `Against run ${report.comparison.data.base.id}, attempt ${report.comparison.data.base.attempt}: ${plural(report.comparison.data.changedJobs.length, "changed job")}.`;
    case "deployments":
      return report.deployments.data && `${plural(report.deployments.data.items.length, "deployment")} tied to the run or its commit.`;
    case "releases":
      return report.releases.data && `${plural(report.releases.data.items.length, "release")} with how each relates to the commit.`;
    case "artifacts":
      return report.artifacts.data && `${plural(report.artifacts.data.items.length, "artifact")} (metadata only).`;
    case "logExcerpts":
      return report.logExcerpts.data ? `${plural(report.logExcerpts.data.excerpts.length, "excerpt")} you selected, shown below exactly as they will be exported.` : " To include lines, open a job's log and use Add to report.";
    default:
      return undefined;
  }
}

export function ExportReport({ env, runRef, latest, viewed, jobs, impact, comparison, excerpts, onRemoveExcerpt, onClose }: Props) {
  const client = useQueryClient();
  // The evidence is a snapshot taken when the preview opens; the excerpts follow the user's choices while it is open.
  // The file holds exactly what the preview shows. The preview closes when the run or attempt changes (the caller
  // keys it), so it never exports another run's or attempt's evidence.
  const [snapshot] = useState((): { input: Omit<ReportInput, "excerpts"> } | { failed: string } => {
    try {
      const evidence = cachedEvidence(client, env, runRef, latest, viewed?.run ?? latest, viewed?.number);
      return { input: { mode: env.mode, repo: { owner: runRef.owner, repo: runRef.repo }, latest, viewedAttempt: viewed, jobs, impact, comparison, ...evidence, generatedAt: new Date().toISOString() } };
    } catch (e) {
      return { failed: message(e) };
    }
  });
  const built = useMemo((): Built => {
    if ("failed" in snapshot) return snapshot;
    try {
      const report = buildReport({ ...snapshot.input, excerpts });
      return { report, errors: validateReport(report).errors };
    } catch (e) {
      return { failed: message(e) };
    }
  }, [snapshot, excerpts]);
  // Errors found in the text to be saved, for the report they were found in.
  const [failure, setFailure] = useState<{ for: Built; errors: string[] }>();
  const [saved, setSaved] = useState(false);

  const download = () => {
    if (!("report" in built)) return;
    const text = JSON.stringify(built.report, null, 2);
    // Checked again on the exact text to be saved.
    const check = validateReport(JSON.parse(text));
    if (!check.ok) {
      setFailure({ for: built, errors: check.errors });
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFilename(built.report);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  };

  const errors = (failure?.for === built ? failure.errors : undefined) ?? ("report" in built ? built.errors : [built.failed]);
  const stepName = (jobId: number, n?: number) => (n === undefined || jobs.state !== "loaded" ? undefined : jobs.value.find((j) => j.id === jobId)?.steps?.find((st) => st.number === n)?.name);
  const report = "report" in built ? built.report : undefined;
  return (
    <section className="export-report" aria-labelledby="export-report-title" data-testid="export-preview">
      <div className="export-report-head">
        <h4 id="export-report-title">Export investigation report</h4>
        <button type="button" onClick={onClose} data-testid="close-export">
          Close
        </button>
      </div>
      {report && (
        <>
          <p className="muted" data-testid="export-identity" data-run={report.run.id} data-attempt={report.run.viewedAttempt}>
            Run {report.run.id}
            {report.run.number !== undefined && ` (#${report.run.number})`}, attempt {report.run.viewedAttempt} of {report.run.latestAttempt}. {report.run.attemptNote}
          </p>
          <p className="note">{NO_CAUSE_NOTE} &ldquo;Not loaded&rdquo; means this page had not loaded that evidence; it is not evidence that none exists.</p>
          <table className="compare-jobs export-sections">
            <thead>
              <tr>
                <th>Section</th>
                <th>State</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {SECTIONS.map(({ key, label, notLoaded }) => {
                const s = report[key];
                return (
                  <tr key={key} data-testid="report-section" data-section={key} data-state={s.state}>
                    <td>{label}</td>
                    <td>
                      <strong>{STATE[s.state]}</strong>
                    </td>
                    <td>
                      {s.state === "not loaded" ? notLoaded : s.reason}
                      {summary(report, key)}
                      {s.missing && (
                        <ul>
                          {s.missing.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {report.logExcerpts.data && (
            <div className="export-excerpts" data-testid="export-excerpts">
              <p className="state" role="note" data-testid="excerpt-warning">
                {report.logExcerpts.data.warning} Masking finds credential-shaped text by pattern; it cannot detect every secret.
              </p>
              {report.logExcerpts.data.excerpts.map((e, i) => (
                <figure key={`${e.jobId}:${e.startLine}:${i}`} className="export-excerpt" data-testid="export-excerpt" data-job={e.jobId} data-step={e.step ?? ""} data-start={e.startLine} data-end={e.endLine} data-masked={e.masked}>
                  <figcaption>
                    <span>
                      <strong>{e.job}</strong> (job {e.jobId}) · {e.step !== undefined ? `step ${e.step}${stepName(e.jobId, e.step) ? ` (${stepName(e.jobId, e.step)})` : ""}` : "no step identified"} · lines {e.startLine}–{e.endLine}
                      {e.masked > 0 && ` · ${plural(e.masked, "masked value")}`}
                      {e.truncated && " · shortened to the report's limits"}
                    </span>
                    <button type="button" onClick={() => onRemoveExcerpt(i)} data-testid="remove-excerpt">
                      Remove
                    </button>
                  </figcaption>
                  <ol className="excerpt-lines" start={e.startLine}>
                    {e.lines.map((l, k) => (
                      <li key={k} data-testid="excerpt-line">
                        <Masked text={l} />
                      </li>
                    ))}
                  </ol>
                </figure>
              ))}
            </div>
          )}
          <ul className="export-caveats" data-testid="export-caveats">
            {report.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
      {errors.length > 0 ? (
        <div className="state state-error" role="alert" data-testid="export-invalid">
          <p>The report did not pass validation, so it cannot be downloaded:</p>
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : (
        report && (
          <div className="export-actions">
            <button type="button" onClick={download} data-testid="download-report">
              Download {reportFilename(report)}
            </button>
            <span className="muted">Saved on this computer only; nothing is uploaded, and the app keeps no copy.</span>
            {saved && (
              <span role="status" data-testid="export-saved">
                Report downloaded.
              </span>
            )}
          </div>
        )
      )}
    </section>
  );
}

/** An exported excerpt line as it will be saved, with the masks `maskCredentials` put in it highlighted. */
function Masked({ text }: { text: string }) {
  const parts = text.split(MASK);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <mark className="masked" title="Masked: credential-shaped text">
              {MASK}
            </mark>
          )}
        </span>
      ))}
    </>
  );
}
