// Job identity within one run attempt, shared by run comparison and run history. Pure: no I/O.
// A job is identified by its workflow identity (job id in the workflow file, the call path inside reusable workflows,
// plus the matrix values or the called job's name); only without a workflow file by its display name, labelled so.
import type { GraphNode, RunGraph } from "../graph/build";
import type { Job } from "../types";

export type Identity = { key: string; basis: "workflow-file" | "name"; label: string; node?: GraphNode };

/** The workflow identity of a node: its context path and job id in the workflow file. */
export function nodeIdentity(n: GraphNode): string | undefined {
  if (n.source !== "workflow-file" || !n.yamlId) return undefined;
  return [...(n.context?.path ?? []), n.yamlId].join("/");
}

/** Each job's identity on one side: its workflow-file identity, or its name when the workflow file is unavailable. */
export function identities(side: { jobs: Job[]; graph: RunGraph | null }): Map<number, Identity> {
  const out = new Map<number, Identity>();
  for (const n of side.graph?.nodes ?? []) {
    const id = nodeIdentity(n);
    for (const m of n.members) {
      if (!id) {
        out.set(m.job.id, { key: `name:${m.job.name}`, basis: "name", label: m.job.name, node: n });
        continue;
      }
      // A matrix leg by its values; a job inside a call shown as one node by its name in the called workflow.
      const part = n.kind === "job" ? "" : `#${m.label}`;
      out.set(m.job.id, { key: `wf:${id}${part}`, basis: "workflow-file", label: n.kind === "job" ? n.label : `${n.label} › ${m.label}`, node: n });
    }
  }
  for (const j of side.jobs) if (!out.has(j.id)) out.set(j.id, { key: `name:${j.name}`, basis: "name", label: j.name });
  return out;
}
