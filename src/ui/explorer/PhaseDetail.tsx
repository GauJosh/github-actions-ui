// Level 2: one phase's jobs and their real dependencies, with neighbours in other phases shown as labelled
// stand-ins. A reusable-workflow call opens as its own context (the called workflow's jobs and needs).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Environment } from "../../app/environment";
import { calledWorkflowGraph, type GraphNode, type RunGraph } from "../../domain/graph/build";
import { phaseGraph, type ReleaseOverview } from "../../domain/phases/phases";
import type { Job } from "../../domain/types";
import { loadCalledWorkflow } from "../../runs/release";
import { shortSha } from "../format";
import { GraphCanvas, type NodeAnnotations } from "./GraphCanvas";
import { PhaseBadge, gateText } from "./ReleaseOverview";

type Props = {
  env: Environment;
  graph: RunGraph;
  overview: ReleaseOverview;
  phaseId: string;
  call?: string;
  selectedJobId?: number;
  onSelectNode(node: GraphNode): void;
  onSelectJob(job: Job, node: GraphNode): void;
  onOpenCall(node: GraphNode): void;
  onCloseCall(): void;
};

export function PhaseDetail({ env, graph, overview, phaseId, call, selectedJobId, onSelectNode, onSelectJob, onOpenCall, onCloseCall }: Props) {
  const phase = overview.phases.find((p) => p.id === phaseId);
  const sub = useMemo(() => phaseGraph(graph, overview, phaseId), [graph, overview, phaseId]);
  // Swimlanes only from groups declared in the repository's phase file (e.g. one per service).
  const lanes = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of sub.nodes) if (overview.nodeGroup.has(n.key)) m.set(n.key, overview.nodeGroup.get(n.key)!);
    return m.size ? m : undefined;
  }, [sub, overview]);
  const ownJobs = sub.nodes.filter((n) => !n.external).reduce((c, n) => c + Math.max(1, n.members.length), 0);
  const annotations: NodeAnnotations = { roles: overview.roles, gates: overview.gates, onOpenCall };
  const callNode = call ? sub.nodes.find((n) => n.yamlId === call && n.kind === "reusable" && !n.external) : undefined;
  const selectedKey = sub.nodes.find((n) => !n.external && n.members.some((m) => m.job.id === selectedJobId))?.key;
  const name = phase?.name ?? "Other jobs";
  const needs = overview.phaseEdges.filter((e) => e.to === phaseId).map((e) => overview.phases.find((p) => p.id === e.from)?.name);
  const feeds = overview.phaseEdges.filter((e) => e.from === phaseId).map((e) => overview.phases.find((p) => p.id === e.to)?.name);

  return (
    <section className="panel phase-detail" id="phase-detail" aria-labelledby="phase-detail-heading" data-testid="phase-detail">
      <header className="panel-head">
        <div>
          <nav className="crumbs" aria-label="Phase context">
            Release › <strong>{name}</strong>
            {callNode && (
              <>
                {" "}
                › <strong>{callNode.label}</strong> <span className="muted">(called workflow)</span>
              </>
            )}
          </nav>
          <h3 id="phase-detail-heading">
            {callNode ? `${callNode.label}: called workflow` : `${name} phase`} {phase && !callNode && <PhaseBadge status={phase.status} />}
          </h3>
        </div>
        {callNode && <button onClick={onCloseCall}>← Back to {name}</button>}
      </header>

      {!callNode && phase && (
        <dl className="facts phase-facts">
          {phase.environment && (
            <>
              <dt>Environment</dt>
              <dd>{phase.environment}</dd>
            </>
          )}
          <dt>Needs</dt>
          <dd>{needs.length ? needs.join(", ") : "no other phase"}</dd>
          <dt>Feeds</dt>
          <dd>{feeds.length ? feeds.join(", ") : "no later phase"}</dd>
          {phase.gate && (
            <>
              <dt>Approval</dt>
              <dd data-testid="phase-gate">
                {gateText(phase.gate)}
                {phase.gate.comment ? ` · “${phase.gate.comment}”` : ""} <span className="muted">(source: {phase.gate.source})</span>
              </dd>
            </>
          )}
          {phase.recovery && phase.recovery !== "none" && (
            <>
              <dt>Recovery</dt>
              <dd>{phase.recovery === "not-needed" ? "not needed (rollback jobs skipped)" : `rollback ${phase.recovery}`}</dd>
            </>
          )}
          {phase.blockedBy && (
            <>
              <dt>{phase.status === "blocked" ? "Blocked by" : "Waiting on"}</dt>
              <dd>{phase.blockedBy.reason}</dd>
            </>
          )}
        </dl>
      )}

      {!callNode && (
        <div className="scope-note" role="note" data-testid="phase-scope">
          <strong>Scoped view.</strong> {ownJobs} job{ownJobs === 1 ? "" : "s"} in {name} and the {sub.scope.internalEdges} dependenc{sub.scope.internalEdges === 1 ? "y" : "ies"} between them.
          {sub.scope.upstream.length + sub.scope.downstream.length > 0 && (
            <>
              {" "}
              Dependencies on other phases are summarised:{" "}
              {[...sub.scope.upstream.map((u) => ({ ...u, dir: "up" as const })), ...sub.scope.downstream.map((d) => ({ ...d, dir: "down" as const }))].map((s, i) => (
                <span key={`${s.dir}-${s.phaseName}`}>
                  {i > 0 && " · "}
                  <button
                    className="linklike"
                    onClick={() => onSelectNode(sub.nodes.find((n) => n.external?.phaseName === s.phaseName && n.external.direction === (s.dir === "up" ? "upstream" : "downstream"))!)}
                    title={s.jobs.join(", ")}
                  >
                    {s.dir === "up" ? `needs ${s.jobs.length} job${s.jobs.length === 1 ? "" : "s"} in ${s.phaseName}` : `${s.jobs.length} job${s.jobs.length === 1 ? "" : "s"} in ${s.phaseName} need this phase`}
                  </button>
                </span>
              ))}
              .
            </>
          )}{" "}
          Every individual edge is in <em>Execution graph (all jobs)</em>.
        </div>
      )}

      {callNode ? (
        <CalledWorkflow env={env} node={callNode} selectedJobId={selectedJobId} onSelectJob={(job) => onSelectJob(job, callNode)} />
      ) : (
        <GraphCanvas graph={sub} selectedKey={selectedKey} selectedJobId={selectedJobId} onSelectNode={onSelectNode} onSelectJob={onSelectJob} annotations={annotations} label={`${name} phase`} fitContent lanes={lanes} />
      )}
    </section>
  );
}

function CalledWorkflow({ env, node, selectedJobId, onSelectJob }: { env: Environment; node: GraphNode; selectedJobId?: number; onSelectJob(job: Job): void }) {
  const resolved = node.resolvedWorkflow;
  const file = useQuery({
    queryKey: ["called-workflow", env.mode, resolved?.path, resolved?.sha],
    queryFn: () => loadCalledWorkflow(env.client, resolved!),
    enabled: Boolean(resolved),
    staleTime: Infinity,
  });
  const inner = useMemo(() => {
    if (!resolved) return calledWorkflowGraph(node, null, { unavailableReason: "GitHub did not report which commit this call resolved to." });
    if (!file.data) return null;
    return "definition" in file.data
      ? calledWorkflowGraph(node, file.data.definition, { file: { path: `${file.data.file.repo}/${file.data.file.path}`, revision: file.data.file.revision } })
      : calledWorkflowGraph(node, null, { unavailableReason: file.data.unavailableReason });
  }, [node, resolved, file.data]);
  if (!inner) return <p className="state">Reading the called workflow…</p>;
  const selectedKey = inner.nodes.find((n) => n.members.some((m) => m.job.id === selectedJobId))?.key;
  return (
    <div className="called" data-testid="called-workflow">
      <p className="evidence-line note">
        Caller job <code>{node.yamlId}</code> uses <code>{node.uses}</code>
        {resolved ? ` · resolved by GitHub to ${shortSha(resolved.sha)}` : ""}.{" "}
        {inner.evidence.kind === "workflow-file" ? `Dependencies from the called workflow file (${inner.evidence.matchedJobs} of ${inner.evidence.totalJobs} jobs matched).` : `${inner.evidence.reason} Jobs are shown without dependency edges.`}
      </p>
      <GraphCanvas graph={inner} selectedKey={selectedKey} selectedJobId={selectedJobId} onSelectNode={(n) => n.members[0] && onSelectJob((n.members.find((m) => m.job.conclusion === "failure") ?? n.members[0]).job)} onSelectJob={(job) => onSelectJob(job)} label={`Called workflow ${node.uses}`} fitContent />
    </div>
  );
}
