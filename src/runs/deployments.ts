// GitHub deployments of one run's commit, each with its statuses, for the release evidence model. Read-only (GET):
// one listing by commit, then each deployment's statuses, at most `concurrency` at once. A deployment whose statuses
// cannot be read keeps `statuses: null` (unknown), which is not the same as an empty list (GitHub reported none).
import type { EvidenceInput, GitHubDeployment, GitHubDeploymentStatus } from "../domain/insights/release-evidence";
import type { RepoRef, Run } from "../domain/types";
import type { GitHubClient } from "../github/client";

export const DEPLOYMENT_LIMITS = { concurrency: 2 };

export type LoadedDeployments = {
  deployments: NonNullable<EvidenceInput["deployments"]>;
  /** GitHub listed more than one page of deployments for this commit; only the first page is used. */
  moreDeployments: boolean;
  /** Deployments whose statuses could not be read. */
  failed: { id: number; why: string }[];
  /** Deployments with more than one page of statuses (the latest status may be beyond the first page). */
  moreStatuses: number[];
  /** Items left out because they lacked the documented fields the model needs. */
  malformed: number;
};

type Client = Pick<GitHubClient, "listDeployments" | "getDeploymentStatuses">;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : null);

/** Deployment fields the model uses, from GitHub's documented response; an item without a numeric id is left out. */
export function toDeployment(v: unknown): GitHubDeployment | null {
  if (!isRecord(v) || typeof v.id !== "number") return null;
  return {
    id: v.id,
    sha: text(v.sha),
    ref: text(v.ref),
    task: text(v.task),
    environment: text(v.environment),
    original_environment: text(v.original_environment),
    ...(typeof v.production_environment === "boolean" && { production_environment: v.production_environment }),
    ...(typeof v.transient_environment === "boolean" && { transient_environment: v.transient_environment }),
    created_at: text(v.created_at),
    updated_at: text(v.updated_at),
  };
}

export function toDeploymentStatus(v: unknown): GitHubDeploymentStatus | null {
  if (!isRecord(v) || typeof v.id !== "number" || typeof v.state !== "string") return null;
  return { id: v.id, state: v.state, environment: text(v.environment), target_url: text(v.target_url), log_url: text(v.log_url), created_at: text(v.created_at) };
}

export async function loadDeployments(client: Client, repo: RepoRef, run: Pick<Run, "head_sha">, signal?: AbortSignal, limits = DEPLOYMENT_LIMITS): Promise<LoadedDeployments> {
  const listed = await client.listDeployments(repo, run.head_sha);
  let malformed = 0;
  const found = (Array.isArray(listed.deployments) ? listed.deployments : []).flatMap((v) => {
    const d = toDeployment(v);
    if (!d) malformed++;
    return d ? [d] : [];
  });
  const out: LoadedDeployments["deployments"] = found.map((deployment) => ({ deployment, statuses: null }));
  const failed: LoadedDeployments["failed"] = [];
  const moreStatuses: number[] = [];
  let next = 0;
  const worker = async () => {
    while (next < out.length) {
      if (signal?.aborted) return;
      const item = out[next++]!;
      try {
        const page = await client.getDeploymentStatuses(repo, item.deployment.id);
        const statuses = (Array.isArray(page.statuses) ? page.statuses : []).flatMap((v) => {
          const s = toDeploymentStatus(v);
          if (!s) malformed++;
          return s ? [s] : [];
        });
        item.statuses = statuses;
        if (page.hasNext) moreStatuses.push(item.deployment.id);
      } catch (error) {
        failed.push({ id: item.deployment.id, why: error instanceof Error ? error.message : "request failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, out.length) }, worker));
  return { deployments: out, moreDeployments: listed.hasNext, failed: failed.sort((a, b) => a.id - b.id), moreStatuses: moreStatuses.sort((a, b) => a - b), malformed };
}
