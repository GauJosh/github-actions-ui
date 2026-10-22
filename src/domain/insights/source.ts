// Workflow source explorer: the workflow files a run used, as declared, from the already-resolved workflow tree
// (src/runs/workflow-tree.ts and resolveCall: no second resolver). Pure: no I/O.
//
// Kept apart: what a file DECLARES (jobs, needs, conditions, environments, inputs passed to calls) and what RAN
// (the run's jobs matched to those declarations by the execution graph). A declared job is linked to the run only
// through the graph's match; YAML alone never says a job ran.
//
// Inputs passed to calls are shown with their provenance: a literal written in the file, a value only known at run
// time (`${{ … }}`), or redacted. Values that reference secrets, or whose input name suggests a credential, are never
// shown. The workflow files themselves are repository source: the explorer shows their structure, not their text.
import type { GraphNode, RunGraph, WorkflowFileRef } from "../graph/build";
import type { WorkflowTree } from "../graph/hierarchy";
import type { WorkflowJobDef } from "../graph/workflow-definition";

export type SourceInput = { name: string; value?: string; kind: "literal" | "expression" | "redacted"; note?: string };
export type SourceJob = {
  id: string;
  name?: string;
  needs: string[];
  condition?: string;
  environment?: string;
  matrix: boolean;
  steps: number;
  /** A reusable-workflow call: the `uses:` value, its inputs, and the called file (a child source node). */
  uses?: string;
  inputs?: SourceInput[];
  call?: SourceNode;
  /** The run's graph node this declaration matched, when the match is reliable. */
  run?: { nodeKey: string; jobs: number; status: GraphNode["status"] } | { declaredOnly: true } | { unknown: string };
};
export type SourceNode = {
  /** The call chain from the run's workflow: call job ids ("" for the run's own workflow). */
  path: string[];
  labels: string[];
  file?: WorkflowFileRef;
  /** Why the file was not read. */
  unavailable?: string;
  jobs: SourceJob[];
  problems: string[];
};

const SECRET = /\bsecrets\.|\bgithub\.token\b/i;
const SENSITIVE_NAME = /pass(word)?|secret|token|credential|private|api[-_]?key|access[-_]?key|\bpwd\b|auth/i;

export function describeInput(name: string, value: string): SourceInput {
  if (SECRET.test(value)) return { name, kind: "redacted", note: "references a secret; not shown" };
  if (SENSITIVE_NAME.test(name)) return { name, kind: "redacted", note: "the input name suggests a credential; not shown" };
  if (value.includes("${{")) return { name, value, kind: "expression", note: "evaluated when the run executed; its value is not in the workflow file" };
  return { name, value, kind: "literal" };
}

/** Builds the source tree. `graph` (the run's execution graph) links declarations to what ran. */
export function buildSourceTree(tree: WorkflowTree, graph?: RunGraph | null, path: string[] = [], labels: string[] = [], depth = 0): SourceNode {
  const nodes = new Map((graph?.nodes ?? []).map((n) => [n.key, n]));
  const def = tree.definition;
  const keyOf = (id: string) => `def:${[...path, id].join("/")}`;
  const jobs: SourceJob[] = (def?.jobs ?? []).map((j: WorkflowJobDef) => {
    const node = nodes.get(keyOf(j.id));
    // A call expanded into its jobs has no node of its own; its jobs are linked inside the child.
    const expanded = !node && (graph?.nodes ?? []).some((n) => n.key.startsWith(`${keyOf(j.id)}/`));
    const run: SourceJob["run"] = !graph
      ? { unknown: "The run's jobs are still loading." }
      : node
        ? node.declaredOnly
          ? { declaredOnly: true }
          : { nodeKey: node.key, jobs: node.members.length, status: node.status }
        : expanded
          ? undefined
          : { unknown: "Not matched to a job of this run (it may be inside a call shown as one node, or its name was ambiguous)." };
    const child = j.uses ? tree.calls.get(j.id) : undefined;
    const label = j.name && !j.name.includes("${{") ? j.name : j.id;
    return {
      id: j.id,
      ...(j.name !== undefined && { name: j.name }),
      needs: j.needs,
      ...(j.ifCondition !== undefined && { condition: j.ifCondition }),
      ...(j.environment !== undefined && { environment: j.environment }),
      matrix: j.matrix,
      steps: j.steps.length,
      ...(j.uses !== undefined && { uses: j.uses, inputs: Object.entries(j.with ?? {}).map(([k, v]) => describeInput(k, v)) }),
      ...(child && depth < 20 && { call: buildSourceTree(child, graph, [...path, j.id], [...labels, label], depth + 1) }),
      ...(j.uses && !child && { call: { path: [...path, j.id], labels: [...labels, label], unavailable: "This call was not resolved (see the execution graph's notes).", jobs: [], problems: [] } }),
      ...(run && { run }),
    };
  });
  return {
    path,
    labels,
    ...(tree.file && { file: tree.file }),
    ...(tree.unavailable !== undefined && { unavailable: tree.unavailable }),
    ...(!def && tree.unavailable === undefined && { unavailable: "The workflow file was not read." }),
    jobs,
    problems: def?.problems ?? [],
  };
}

/** Every source node, depth first, for navigation. */
export function flattenSource(root: SourceNode): SourceNode[] {
  const out: SourceNode[] = [root];
  for (const j of root.jobs) if (j.call) out.push(...flattenSource(j.call));
  return out;
}

export const githubBlobUrl = (f: WorkflowFileRef) => `https://github.com/${f.repo}/blob/${f.revision}/${f.path}`;
