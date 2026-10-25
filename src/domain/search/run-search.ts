// Pipeline-wide search over one run attempt's metadata: job names and ids, step names, the workflow source the
// run used (step definitions, called workflows, conditions, environments) and failure and dependency facts.
// Pure: no I/O. Log lines are searched separately, in the log workers (domain/logs/queries.ts).
import { defaultStepName } from "../graph/workflow-definition";
import type { RunGraph } from "../graph/build";
import type { Impact } from "../insights/impact";
import type { Job } from "../types";

export type EntryKind = "job" | "step" | "source" | "failure";

export type SearchEntry = {
  kind: EntryKind;
  /** The searched text. */
  text: string;
  /** Where it is, for the result's context line. */
  context: string;
  jobId?: number;
  step?: number;
  nodeKey?: string;
};

export type MetaMatch = SearchEntry & { ranges: [number, number][] };

export function buildSearchIndex(graph: RunGraph | null, jobs: Job[], impact: Impact | null): SearchEntry[] {
  const out: SearchEntry[] = [];
  const nodeOf = new Map<number, RunGraph["nodes"][number]>();
  for (const n of graph?.nodes ?? []) for (const m of n.members) nodeOf.set(m.job.id, n);
  for (const job of jobs) {
    const n = nodeOf.get(job.id);
    const where = n?.context ? `in ${n.context.labels.join(" › ")}` : "job";
    out.push({ kind: "job", text: job.name, context: where, jobId: job.id, nodeKey: n?.key });
    if (n?.yamlId && n.yamlId !== job.name) out.push({ kind: "job", text: `id: ${[...(n.context?.path ?? []), n.yamlId].join("/")}`, context: `workflow job id of ${job.name}`, jobId: job.id, nodeKey: n.key });
    for (const s of job.steps ?? []) out.push({ kind: "step", text: s.name, context: `step ${s.number} of ${job.name}`, jobId: job.id, step: s.number, nodeKey: n?.key });
  }
  for (const n of graph?.nodes ?? []) {
    const first = n.members[0]?.job.id;
    const where = `${n.label} (workflow file)`;
    if (n.uses) out.push({ kind: "source", text: `uses: ${n.uses}`, context: where, jobId: first, nodeKey: n.key });
    if (n.condition) out.push({ kind: "source", text: `if: ${n.condition}`, context: where, jobId: first, nodeKey: n.key });
    if (n.environment) out.push({ kind: "source", text: `environment: ${n.environment}`, context: where, jobId: first, nodeKey: n.key });
    (n.stepDefs ?? []).forEach((d, i) => {
      const name = defaultStepName(d) ?? `step ${i + 1}`;
      const ctx = `${n.label} › ${name} (workflow file)`;
      if (d.name) out.push({ kind: "source", text: `name: ${d.name}`, context: ctx, jobId: first, nodeKey: n.key });
      if (d.uses) out.push({ kind: "source", text: `uses: ${d.uses}`, context: ctx, jobId: first, nodeKey: n.key });
      for (const line of (d.run ?? "").split("\n")) if (line.trim()) out.push({ kind: "source", text: line.trim(), context: `${ctx}, run:`, jobId: first, nodeKey: n.key });
    });
  }
  const label = (k: string) => graph?.nodes.find((n) => n.key === k)?.label ?? k;
  for (const f of impact?.failures ?? []) {
    for (const j of f.jobs) {
      const how = j.kind === "cancelled" ? "was cancelled" : j.kind === "timed_out" ? "timed out" : "failed";
      out.push({ kind: "failure", text: `${j.job.name} ${how}${j.step ? ` at step “${j.step.name}”` : ""}`, context: "failure", jobId: j.job.id, step: j.step?.number, nodeKey: f.key });
    }
    for (const d of f.downstream) {
      if (d.reason !== "blocked" && d.reason !== "possibly") continue;
      out.push({
        kind: "failure",
        text: `${label(d.key)} ${d.reason === "blocked" ? "not run because" : "possibly not run because"} ${f.label} ${f.kind === "cancelled" ? "was cancelled" : "failed"}`,
        context: `needs ${d.via.map(label).join(", ")}`,
        jobId: graph?.nodes.find((n) => n.key === d.key)?.members[0]?.job.id,
        nodeKey: d.key,
      });
    }
  }
  return out;
}

/** What a compiled search provides (the log view's `compileSearch` builds one). */
export type TextMatcher = { test(text: string): boolean; ranges(text: string): [number, number][] };

/** Entries matching the search, with match ranges. No matcher (an empty search): no matches. */
export function searchIndex(entries: SearchEntry[], m: TextMatcher | null, kinds?: EntryKind[]): MetaMatch[] {
  if (!m) return [];
  const wanted = kinds ? new Set(kinds) : null;
  const matches: MetaMatch[] = [];
  for (const e of entries) {
    if (wanted && !wanted.has(e.kind)) continue;
    if (m.test(e.text)) matches.push({ ...e, ranges: m.ranges(e.text) });
  }
  return matches;
}
