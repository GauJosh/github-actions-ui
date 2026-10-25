// One side of a comparison: a run at an explicit attempt, with that attempt's jobs and the graph built from them.
// Queries share their keys with the run view, so an attempt already open is not fetched again. Every request is a
// GET; nothing falls back to another attempt's data.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Environment } from "../../app/environment";
import type { Side } from "../../domain/compare/runs";
import type { RunRef } from "../../domain/types";
import { AttemptMismatchError } from "../../github/client";
import { graphFor, loadWorkflowDefinition, rootFile } from "../../runs/workflow-graph";
import { loadWorkflowTree } from "../../runs/workflow-tree";

export function useRunSide(env: Environment, ref: RunRef, attempt: number | undefined) {
  const key = [env.mode, ref.owner, ref.repo, ref.runId];
  const enabled = attempt !== undefined;
  const run = useQuery({
    queryKey: ["run", ...key, "attempt", attempt],
    queryFn: async () => {
      const r = await env.client.getRun(ref, attempt);
      if (r.run_attempt !== attempt) throw new AttemptMismatchError(attempt!, r.run_attempt);
      return r;
    },
    enabled,
    staleTime: 60_000,
  });
  const jobs = useQuery({ queryKey: ["jobs", ...key, attempt], queryFn: () => env.client.getJobs(ref, attempt), enabled });
  const definition = useQuery({
    queryKey: ["workflow-definition", ...key, run.data?.head_sha, run.data?.path],
    queryFn: () => loadWorkflowDefinition(env.client, ref, run.data!),
    enabled: run.isSuccess,
    staleTime: Infinity,
  });
  const def = definition.data && "definition" in definition.data ? definition.data : null;
  const callsSomething = Boolean(def?.definition.jobs.some((j) => j.uses));
  const hierarchy = useQuery({
    queryKey: ["workflow-tree", ...key, attempt, run.data?.head_sha, run.data?.path],
    queryFn: () => loadWorkflowTree(env.client, run.data!, { definition: def!.definition, file: rootFile(ref, run.data!, def!) }),
    enabled: callsSomething,
    staleTime: Infinity,
  });
  const pending = run.isPending || jobs.isPending || definition.isPending || (callsSomething && hierarchy.isPending);
  const side = useMemo((): Side | null => {
    if (pending || !run.data || !jobs.data || attempt === undefined) return null;
    const result = definition.data ?? { unavailableReason: "The workflow file could not be loaded." };
    const graph = graphFor(ref, run.data, jobs.data, result, hierarchy.data);
    return { run: run.data, attempt, jobs: jobs.data, graph, workflowText: "text" in result ? (result.text ?? null) : null };
  }, [pending, run.data, jobs.data, definition.data, hierarchy.data, attempt, ref]);
  const error = run.error ?? jobs.error ?? null;
  return { side, error, loading: enabled && pending && !error, refetch: () => (void run.refetch(), void jobs.refetch()) };
}
