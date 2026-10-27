// GitHub deployments of this run's commit, loaded on request (read-only): each deployment's environment, latest
// status, and how it is tied to this run. A deployment is confirmed for this run only when GitHub's own status links
// to it; a successful run is never shown as a successful deployment. Each row also says how it relates to this run's
// jobs that use the same environment (environmentJoin): tied to a job only when a status names that job.
// Releases are loaded separately, on request: only releases whose tag resolves to this commit are listed; the rest are
// counted by outcome. A release shares a commit with deployments; that never makes it "deployed".
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Environment } from "../../app/environment";
import type { DeploymentRecord } from "../../domain/insights/deployments";
import { environmentJoin, releaseEvidence, type Association, type DeploymentEvidence, type EnvironmentMatch } from "../../domain/insights/release-evidence";
import type { Job, Run, RunRef } from "../../domain/types";
import { loadDeployments } from "../../runs/deployments";
import { hasMoreReleases, loadMoreReleases, loadReleases, RELEASE_LIMITS, type LoadedReleases as LoadedReleaseList } from "../../runs/releases";
import { ErrorState } from "../RepoDashboard";

type Props = { env: Environment; runRef: RunRef; run: Run; records?: DeploymentRecord[]; jobs?: Job[] };

const ASSOCIATION: Record<Association, string> = {
  confirmed: "Confirmed for this run",
  "same commit": "Same commit only",
  conflicting: "Conflicting evidence",
  unknown: "Unknown",
};

const OUTCOME: Record<DeploymentEvidence["outcome"], string> = {
  succeeded: "succeeded",
  failed: "failed",
  "in progress": "in progress",
  pending: "pending",
  waiting: "waiting",
  inactive: "inactive (superseded or retired)",
  "no status": "no status reported",
  "statuses not loaded": "status could not be loaded",
  "unrecognised status": "unrecognised status",
};

const MATCH: Record<EnvironmentMatch, (env: string, job?: string) => string> = {
  "job linked": (env, job) => `Job ${job} · ${env}: its status names this job`,
  "run confirmed": (env) => `This run's ${env} jobs: which one created it is not named`,
  candidate: (env) => `Candidate for this run's ${env} jobs: same environment and commit only`,
  "another run": (env) => `This run's jobs also use ${env}, but this deployment links to another run`,
  conflicting: (env) => `This run's ${env} jobs: conflicting evidence`,
  unknown: (env) => `This run's ${env} jobs: cannot be compared`,
};

export function RunDeployments({ env, runRef, run, records, jobs }: Props) {
  const [requested, setRequested] = useState(false);
  const query = useQuery({
    queryKey: ["deployments", env.mode, runRef.owner, runRef.repo, run.id, run.head_sha],
    // React Query aborts the signal when the run changes or the view closes; no further status requests start then.
    queryFn: ({ signal }) => loadDeployments(env.client, runRef, run, signal),
    enabled: requested,
    staleTime: 60_000,
  });
  const commit = run.head_sha.slice(0, 7);

  return (
    <section className="compare-section run-deployments" aria-labelledby="run-deployments-title" data-testid="run-deployments">
      <div className="compare-section-head">
        <h4 id="run-deployments-title">GitHub deployments of commit {commit}</h4>
        {!requested && (
          <button type="button" onClick={() => setRequested(true)} data-testid="load-deployments">
            Load deployments
          </button>
        )}
      </div>
      {!requested ? (
        <p className="note">Reads GitHub&apos;s deployment records for this commit and their statuses. Nothing is loaded until you ask.</p>
      ) : query.isPending ? (
        <p className="state">Loading deployments of {commit}…</p>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Loaded run={run} runRef={runRef} data={query.data} records={records} jobs={jobs} />
      )}
      <Releases env={env} runRef={runRef} run={run} deployments={query.data?.deployments ?? null} />
    </section>
  );
}

type LoadedDeploymentList = Awaited<ReturnType<typeof loadDeployments>>["deployments"];

const names = (list: { tag: string }[]) => list.slice(0, 5).map((r) => r.tag).join(", ") + (list.length > 5 ? ", …" : "");

/** Releases of the repository against this run's commit, through the release loader and evidence model. */
function Releases({ env, runRef, run, deployments }: { env: Environment; runRef: RunRef; run: Run; deployments: LoadedDeploymentList | null }) {
  const queryClient = useQueryClient();
  // 0: nothing requested; n: the n-th check, built on the cached result of check n - 1 (never changing it).
  const [check, setCheck] = useState(0);
  const keyOf = (n: number) => ["releases", env.mode, runRef.owner, runRef.repo, run.id, run.head_sha, n] as const;
  const previous = check > 1 ? queryClient.getQueryData<LoadedReleaseList>(keyOf(check - 1)) : undefined;
  const query = useQuery({
    queryKey: keyOf(check),
    // Aborted when the run changes or the view closes: no further tag request starts, and a partial result is dropped.
    queryFn: async ({ signal }) => {
      const before = check > 1 ? queryClient.getQueryData<LoadedReleaseList>(keyOf(check - 1)) : undefined;
      if (check > 1 && !before) throw new Error("The earlier release checks are no longer held; load the releases again.");
      const loaded = before ? await loadMoreReleases(env.client, runRef, run, before, signal) : await loadReleases(env.client, runRef, run, signal);
      if (loaded.cancelled) throw new DOMException("Release loading was cancelled", "AbortError");
      return loaded;
    },
    enabled: check > 0,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    // The earlier checks stay on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
  const commit = run.head_sha.slice(0, 7);
  // A failed check shows its error below the results of the check before it.
  const data = query.data ?? (query.isError ? previous : undefined);
  const busy = query.isFetching;
  const more = data && !query.isError && hasMoreReleases(data);
  return (
    <div className="run-releases" data-testid="run-releases">
      <div className="compare-section-head">
        <h4>GitHub releases of commit {commit}</h4>
        {check === 0 && (
          <button type="button" onClick={() => setCheck(1)} data-testid="load-releases">
            Load releases
          </button>
        )}
      </div>
      {check === 0 ? (
        <p className="note">Reads the repository&apos;s latest releases and checks which tags point to this commit. Nothing is loaded until you ask.</p>
      ) : !data && query.isPending ? (
        <p className="state">Loading releases…</p>
      ) : (
        <>
          {data && <LoadedReleases run={run} runRef={runRef} data={data} deployments={deployments} />}
          {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
          {query.isPlaceholderData && busy && (
            <p className="state" data-testid="releases-checking">
              Checking more releases…
            </p>
          )}
          {more && (
            <button type="button" disabled={busy} onClick={() => !busy && setCheck((n) => n + 1)} data-testid="check-more-releases">
              {data.unresolved > 0 ? `Check the next ${Math.min(RELEASE_LIMITS.tags, data.unresolved)} releases` : "List and check older releases"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function LoadedReleases({ run, runRef, data, deployments }: { run: Run; runRef: RunRef; data: LoadedReleaseList; deployments: LoadedDeploymentList | null }) {
  const evidence = releaseEvidence({ repo: runRef, run, deployments, releases: data.releases });
  const idOf = (v: unknown) => (typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "number" ? (v as { id: number }).id : null);
  const state = new Map(data.releases.map((r) => [idOf(r.release), r.tag.state]));
  const confirmed = evidence.releases.filter((r) => r.commit.match === "confirmed commit");
  const different = evidence.releases.filter((r) => r.commit.match === "different commit");
  const conflicting = evidence.releases.filter((r) => r.commit.match === "conflicting");
  const rest = evidence.releases.filter((r) => r.commit.match === "possible" || r.commit.match === "unknown");
  const notLookedUp = rest.filter((r) => state.get(r.id) === "not loaded");
  const unresolved = rest.filter((r) => state.get(r.id) !== "not loaded");
  if (!evidence.releases.length && !evidence.malformedReleases) return <p className="note" data-testid="releases-note">GitHub lists no releases for this repository.</p>;
  return (
    <>
      {confirmed.length ? (
        <ul className="run-release-list">
          {confirmed.map((r) => (
            <li key={r.id} data-testid="release-confirmed" data-id={r.id}>
              <strong>{r.tag}</strong>
              {r.name && r.name !== r.tag && <span> · {r.name}</span>}
              {r.draft && <span className="chip">draft</span>}
              {r.prerelease && <span className="chip">prerelease</span>}
              {r.url && (
                <>
                  {" "}
                  <a href={r.url} target="_blank" rel="noreferrer">
                    Open on GitHub
                  </a>
                </>
              )}
              <div className="muted">
                {r.commit.basis.join(" ")} {r.run.basis}
              </div>
              <div className="muted" data-testid="release-deployments">
                {deployments === null
                  ? "Deployments of this commit are not loaded; load them above to compare."
                  : r.deployments.length
                    ? `Deployment${r.deployments.length === 1 ? "" : "s"} of this commit: ${r.deployments.map((d) => `${d.environment ?? "no environment"} #${d.id}`).join(", ")}. Same commit; this does not establish that this release was deployed.`
                    : "GitHub lists no deployment of this commit."}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note" data-testid="releases-none-confirmed">
          No release&apos;s tag was confirmed to point to this commit.
        </p>
      )}
      <ul className="run-release-counts">
        {different.length > 0 && (
          <li data-testid="release-count" data-kind="different commit">
            {different.length} resolve{different.length === 1 ? "s" : ""} to a different commit ({names(different)}).
          </li>
        )}
        {conflicting.length > 0 && (
          <li data-testid="release-count" data-kind="conflicting">
            {conflicting.length} with conflicting tag data ({names(conflicting)}).
          </li>
        )}
        {unresolved.length > 0 && (
          <li data-testid="release-count" data-kind="unresolved">
            {unresolved.length} looked up but not resolved ({names(unresolved)})
            {data.failed.length > 0 && `; lookup failed for ${data.failed.map((f) => `${f.tag} (${f.why})`).join(", ")}`}.
          </li>
        )}
        {notLookedUp.length > 0 && (
          <li data-testid="release-count" data-kind="not looked up">
            {notLookedUp.length} not looked up yet; each check looks up at most {RELEASE_LIMITS.tags} ({names(notLookedUp)}).
          </li>
        )}
        {evidence.malformedReleases > 0 && (
          <li data-testid="release-count" data-kind="malformed">
            {evidence.malformedReleases} left out because GitHub&apos;s response lacked expected fields.
          </li>
        )}
      </ul>
      {unresolved.length + notLookedUp.length > 0 && (
        <p className="note" data-testid="releases-note">
          Releases whose tags were not resolved or not looked up are neither a match nor a mismatch with this commit.
        </p>
      )}
      <p className="note" data-testid="releases-progress">
        Tags looked up for {evidence.releases.length - notLookedUp.length} of {evidence.releases.length} listed releases ({data.pages} page{data.pages === 1 ? "" : "s"} of 30 read
        {data.moreReleases ? "; GitHub lists older releases" : ""}).
      </p>
    </>
  );
}

function Loaded({ run, runRef, data, records, jobs }: { run: Run; runRef: RunRef; data: Awaited<ReturnType<typeof loadDeployments>>; records?: DeploymentRecord[]; jobs?: Job[] }) {
  const evidence = releaseEvidence({ repo: runRef, run, deployments: data.deployments });
  // Without the run's job-environment records (the workflow file is still loading or unavailable), nothing is joined.
  const join = records ? environmentJoin(records, evidence) : null;
  const byDeployment = new Map<number, { text: string; match: EnvironmentMatch | "none"; basis: string }>();
  for (const r of join?.records ?? []) {
    for (const m of r.deployments) {
      const name = m.jobId !== undefined ? (jobs?.find((j) => j.id === m.jobId)?.name ?? `#${m.jobId}`) : undefined;
      byDeployment.set(m.id, { text: MATCH[m.match](r.environment, name), match: m.match, basis: m.basis });
    }
  }
  for (const u of join?.unmatched ?? []) byDeployment.set(u.id, { text: u.basis, match: "none", basis: u.basis });
  const missing = join?.records.filter((r) => r.note) ?? [];
  return (
    <>
      <p className="note" data-testid="deployments-scope">
        Only deployments GitHub records for this exact commit; this is not the repository&apos;s deployment history. A deployment is confirmed for this run
        only when one of its statuses links to this run.
      </p>
      {evidence.deployments.length > 0 && (
        <table className="compare-jobs" data-testid="deployments-table">
          <thead>
            <tr>
              <th>Environment</th>
              <th>Latest status</th>
              <th>Tie to this run</th>
            </tr>
          </thead>
          <tbody>
            {evidence.deployments.map((d) => (
              <tr key={d.id} data-testid="deployment" data-id={d.id} data-association={d.association} data-outcome={d.outcome}>
                <td>
                  {d.environment ?? <span className="muted">no environment</span>}
                  {d.production && <span className="muted"> · production</span>}
                  <div className="muted">
                    #{d.id} · {d.sha ? d.sha.slice(0, 7) : "no commit"}
                    {d.createdAt && ` · ${d.createdAt.replace("T", " ").replace("Z", " UTC")}`}
                  </div>
                </td>
                <td>{OUTCOME[d.outcome]}</td>
                <td>
                  <strong>{ASSOCIATION[d.association]}</strong>
                  {d.linkedRunId !== undefined && <span className="muted"> · links to run {d.linkedRunId}</span>}
                  <div className="muted">{d.basis.join(" ")}</div>
                  {byDeployment.has(d.id) && (
                    <div className="muted" data-testid="deployment-job-env" data-match={byDeployment.get(d.id)!.match} title={byDeployment.get(d.id)!.basis}>
                      {byDeployment.get(d.id)!.text}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.failed.length > 0 && (
        <p className="state state-warn" data-testid="deployments-failed">
          The statuses of {data.failed.length} deployment{data.failed.length === 1 ? "" : "s"} could not be loaded ({data.failed.map((f) => `#${f.id}`).join(", ")}): their
          outcome and their tie to this run are unknown, not absent.
        </p>
      )}
      {data.moreDeployments && <p className="note">GitHub lists more than 100 deployments of this commit; only the first 100 are shown.</p>}
      {data.moreStatuses.length > 0 && <p className="note">Some deployments have more than 100 statuses; only the first 100 were read.</p>}
      {data.malformed > 0 && <p className="note">{data.malformed} item{data.malformed === 1 ? " was" : "s were"} left out because GitHub&apos;s response lacked expected fields.</p>}
      {missing.length > 0 && (
        <p className="note" data-testid="deployments-env-missing">
          {missing.map((r) => r.note).join(" ")}
        </p>
      )}
      {evidence.notes.map((n) => (
        <p key={n} className="note" data-testid="deployments-note">
          {n}
        </p>
      ))}
    </>
  );
}
