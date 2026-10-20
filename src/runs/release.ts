// Loads the extra evidence for the release overview, on demand and read-only:
// - the optional phase file `.github/actions-ui-phases.yml` at the run's commit;
// - deployment approval history and pending deployments for the run;
// - a called (reusable) workflow's file at the commit GitHub resolved it to.
// Missing or unreadable evidence is reported, never replaced by guesses.
import { readWorkflowDefinition, type WorkflowDefinition } from "../domain/graph/workflow-definition";
import { readPhaseManifest, type ApprovalRecord, type PendingDeployment, type PhaseManifest } from "../domain/phases/phases";
import type { RepoRef, Run, RunRef } from "../domain/types";
import { GitHubError, type GitHubClient } from "../github/client";

export const PHASE_FILE = ".github/actions-ui-phases.yml";

const parseYaml = async (text: string): Promise<unknown> => (await import("yaml")).parse(text);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type ManifestResult = { manifest: PhaseManifest | null; note?: string };

export async function loadPhaseManifest(client: GitHubClient, repo: RepoRef, run: Run): Promise<ManifestResult> {
  if (!run.path) return { manifest: null };
  let text: string;
  try {
    text = await client.getWorkflowFile(repo, PHASE_FILE, run.head_sha);
  } catch (error) {
    if (error instanceof GitHubError && error.failure.kind === "not-found-or-no-permission") return { manifest: null };
    return { manifest: null, note: `The phase file ${PHASE_FILE} could not be read.` };
  }
  try {
    const result = readPhaseManifest(await parseYaml(text), run.path, PHASE_FILE);
    if (result && "error" in result) return { manifest: null, note: `${PHASE_FILE}: ${result.error}` };
    return { manifest: result };
  } catch {
    return { manifest: null, note: `${PHASE_FILE} is not valid YAML.` };
  }
}

export function toApprovalRecords(body: unknown[]): ApprovalRecord[] {
  return body.filter(isRecord).flatMap((a) => {
    if (a.state !== "approved" && a.state !== "rejected") return [];
    const environments = Array.isArray(a.environments) ? a.environments.filter(isRecord).map((e) => String(e.name)) : [];
    const user = isRecord(a.user) && typeof a.user.login === "string" ? a.user.login : undefined;
    return [{ state: a.state, environments, user, comment: typeof a.comment === "string" ? a.comment : undefined }];
  });
}

export function toPendingDeployments(body: unknown[]): PendingDeployment[] {
  return body.filter(isRecord).flatMap((p) => {
    if (!isRecord(p.environment) || typeof p.environment.name !== "string") return [];
    const reviewers = Array.isArray(p.reviewers)
      ? p.reviewers.filter(isRecord).map((r) => (isRecord(r.reviewer) ? String(r.reviewer.login ?? r.reviewer.slug ?? r.reviewer.name ?? "reviewer") : "reviewer"))
      : [];
    return [{ environment: p.environment.name, reviewers }];
  });
}

export type GateEvidence = { approvals: ApprovalRecord[] | null; pending: PendingDeployment[] | null; note?: string };

/** Approval history always; pending deployments only when something in the run is waiting. */
export async function loadGateEvidence(client: GitHubClient, ref: RunRef, anyWaiting: boolean): Promise<GateEvidence> {
  const notes: string[] = [];
  let approvals: ApprovalRecord[] | null = null;
  let pending: PendingDeployment[] | null = null;
  try {
    approvals = toApprovalRecords(await client.getApprovals(ref));
  } catch {
    notes.push("Deployment approval history could not be read; gate states come from job statuses only.");
  }
  if (anyWaiting) {
    try {
      pending = toPendingDeployments(await client.getPendingDeployments(ref));
    } catch {
      notes.push("Pending deployments could not be read.");
    }
  }
  return { approvals, pending, note: notes.join(" ") || undefined };
}

export type CalledWorkflowResult =
  | { definition: WorkflowDefinition; file: { repo: string; path: string; revision: string } }
  | { unavailableReason: string };

/** Reads a called workflow from GitHub's resolved reference, e.g. "owner/repo/.github/workflows/ci.yml@ref" at `sha`. */
export async function loadCalledWorkflow(client: GitHubClient, resolved: { path: string; sha: string }): Promise<CalledWorkflowResult> {
  const m = /^([^/]+)\/([^/]+)\/(.+?)@.+$/.exec(resolved.path);
  if (!m) return { unavailableReason: "GitHub's reference to the called workflow could not be read." };
  const [, owner, repo, path] = m as unknown as [string, string, string, string];
  try {
    const text = await client.getWorkflowFile({ owner, repo }, path, resolved.sha);
    const definition = readWorkflowDefinition(await parseYaml(text));
    if ("error" in definition) return { unavailableReason: definition.error };
    return { definition, file: { repo: `${owner}/${repo}`, path, revision: resolved.sha } };
  } catch (error) {
    if (error instanceof GitHubError) return { unavailableReason: `The called workflow ${owner}/${repo}/${path} could not be read with this token.` };
    return { unavailableReason: "The called workflow could not be parsed." };
  }
}
