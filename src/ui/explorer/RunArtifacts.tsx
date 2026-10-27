// GitHub artifacts of this workflow run, loaded on request (read-only metadata; nothing is downloaded and no
// download URL is used). Classification and wording come from the artifact evidence model: an artifact is confirmed
// for the run only when its own metadata names the run; it is never tied to an attempt, a release or a deployment.
//
// The model gets the run as GitHub reports it now (its latest attempt) and, separately, the attempt on screen: an
// earlier attempt's own data reports that attempt's number and would wrongly look like a single-attempt run.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Environment } from "../../app/environment";
import { artifactEvidence, type ArtifactAssociation, type ArtifactSummary } from "../../domain/insights/artifacts";
import type { Run, RunRef } from "../../domain/types";
import { ARTIFACT_LIMITS, loadArtifacts, MalformedArtifactListing } from "../../runs/artifacts";
import { ErrorState } from "../RepoDashboard";

type Props = { env: Environment; runRef: RunRef; latest: Run; viewedAttempt?: number };

const ASSOCIATION: Record<ArtifactAssociation, string> = {
  confirmed: "Confirmed for this run",
  unknown: "Run not named in its metadata",
  conflicting: "Conflicting evidence",
};

const LISTING: Record<ArtifactSummary["listing"], string> = {
  "not loaded": "Not loaded",
  "none listed": "None listed",
  complete: "Complete listing",
  incomplete: "Incomplete listing",
};

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
const time = (iso: string) => iso.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");

export function RunArtifacts({ env, runRef, latest, viewedAttempt }: Props) {
  const [requested, setRequested] = useState(false);
  const query = useQuery({
    // The listing is per run; the latest attempt number and status are in the key because the wording depends on them.
    queryKey: ["artifacts", env.mode, runRef.owner, runRef.repo, latest.id, latest.run_attempt, latest.status],
    // Aborted when the run changes or the view closes: no further page is requested, and a partial result is dropped.
    queryFn: async ({ signal }) => {
      const loaded = await loadArtifacts(env.client, { owner: runRef.owner, repo: runRef.repo, runId: latest.id }, signal);
      if (loaded.cancelled) throw new DOMException("Artifact loading was cancelled", "AbortError");
      return loaded;
    },
    enabled: requested,
    staleTime: 60_000,
  });

  return (
    <section className="compare-section run-artifacts" aria-labelledby="run-artifacts-title" data-testid="run-artifacts">
      <div className="compare-section-head">
        <h4 id="run-artifacts-title">GitHub artifacts of this run</h4>
        {!requested && (
          <button type="button" onClick={() => setRequested(true)} data-testid="load-artifacts">
            Load artifacts
          </button>
        )}
      </div>
      {!requested ? (
        <p className="note" data-testid="artifacts-listing" data-state="not loaded">
          Reads the metadata GitHub lists for this run&apos;s artifacts (up to {ARTIFACT_LIMITS.pages * 100}); nothing is downloaded. Nothing is loaded until you ask.
        </p>
      ) : query.isPending ? (
        <p className="state">Loading artifacts…</p>
      ) : query.isError ? (
        <div data-testid="artifacts-listing" data-state="unavailable">
          {query.error instanceof MalformedArtifactListing ? (
            <div className="state state-error" role="alert">
              <p>{query.error.message}</p>
              <button onClick={() => void query.refetch()}>Try again</button>
            </div>
          ) : (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          )}
          <p className="note">The artifacts are unavailable, not absent: no partial listing is shown.</p>
        </div>
      ) : (
        <Loaded summary={artifactEvidence({ run: latest, viewedAttempt, listing: query.data })} />
      )}
    </section>
  );
}

function Loaded({ summary }: { summary: ArtifactSummary }) {
  return (
    <>
      <p className="note" data-testid="artifacts-listing" data-state={summary.listing} data-attempt={summary.attempt}>
        <strong>{LISTING[summary.listing]}</strong>
        {summary.listing === "incomplete" ? ` · ${summary.read + summary.malformed} read of ${summary.totalCount} GitHub lists` : summary.listing === "complete" ? ` · ${summary.read} artifact${summary.read === 1 ? "" : "s"}` : ""}
      </p>
      {summary.artifacts.length > 0 && (
        <table className="compare-jobs" data-testid="artifacts-table">
          <thead>
            <tr>
              <th>Artifact</th>
              <th>Size</th>
              <th>Expiry</th>
              <th>Tie to this run</th>
            </tr>
          </thead>
          <tbody>
            {summary.artifacts.map((a) => (
              <tr key={a.id} data-testid="artifact" data-id={a.id} data-association={a.association} data-expired={a.expired}>
                <td>
                  {a.name}
                  <div className="muted">
                    #{a.id}
                    {a.createdAt && ` · created ${time(a.createdAt)}`}
                  </div>
                  {a.digest && (
                    <div className="muted" data-testid="artifact-digest" title="GitHub's digest of the stored archive, as reported; not proof of its contents' origin.">
                      digest {a.digest.length > 24 ? `${a.digest.slice(0, 24)}…` : a.digest}
                    </div>
                  )}
                </td>
                <td>{size(a.sizeInBytes)}</td>
                <td data-testid="artifact-expiry">
                  {a.expired ? <strong>Expired · metadata only</strong> : "Not expired"}
                  {a.expiresAt && <div className="muted">{a.expired ? "expired" : "expires"} {time(a.expiresAt)}</div>}
                </td>
                <td>
                  <strong>{ASSOCIATION[a.association]}</strong>
                  <div className="muted">{a.basis}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {summary.notes.map((n) => (
        <p key={n} className="note" data-testid="artifacts-note">
          {n}
        </p>
      ))}
    </>
  );
}
