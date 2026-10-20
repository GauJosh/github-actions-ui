// Level 1: the release at a glance. One card per phase (CI, Dev, Test, Stage, Prod…) in execution order, with
// progress, approval gate, failures, recovery and what is blocked, plus why the run stopped or paused.
// Arrows between phases appear only where real job dependencies cross from one phase to the next.
import { jobStatus, type GraphNode, type NodeStatus, type RunGraph } from "../../domain/graph/build";
import { PHASE_STATUS_TEXT, type Phase, type PhaseStatus, type ReleaseOverview as Overview } from "../../domain/phases/phases";
import { durationMs } from "../../domain/graph/build";
import { formatDuration } from "../format";

const PHASE_GLYPH: Record<PhaseStatus, string> = {
  succeeded: "✓",
  failed: "✕",
  recovered: "↩",
  recovering: "↩",
  "recovery-failed": "✕",
  rejected: "⊘",
  "awaiting-approval": "⏸",
  running: "◐",
  pending: "…",
  blocked: "⛔",
  skipped: "↷",
  cancelled: "⊘",
  "not-started": "·",
};

export function PhaseBadge({ status }: { status: PhaseStatus }) {
  return (
    <span className={`pbadge ps-${status}`} data-phase-status={status}>
      <span aria-hidden="true">{PHASE_GLYPH[status]}</span> {PHASE_STATUS_TEXT[status]}
    </span>
  );
}

const SEGMENTS: [string, NodeStatus[]][] = [
  ["success", ["success", "neutral"]],
  ["failure", ["failure", "timed_out", "cancelled"]],
  ["running", ["in_progress", "queued", "waiting"]],
  ["skipped", ["skipped"]],
];

function ProgressBar({ phase, nodes }: { phase: Phase; nodes: Map<string, GraphNode> }) {
  const jobs = phase.nodeKeys.flatMap((k) => nodes.get(k)!.members.map((m) => jobStatus(m.job)));
  const total = Math.max(phase.total, 1);
  return (
    <span className="pbar" aria-hidden="true">
      {SEGMENTS.map(([cls, states]) => {
        const n = jobs.filter((s) => states.includes(s)).length;
        return n ? <span key={cls} className={`pbar-${cls}`} style={{ width: `${(n / total) * 100}%` }} /> : null;
      })}
    </span>
  );
}

/** "3 succeeded · 1 failed · 2 skipped", counting jobs (and declared jobs that have not started). */
function breakdown(phase: Phase, nodes: Map<string, GraphNode>): string {
  const counts = new Map<string, number>();
  const add = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const key of phase.nodeKeys) {
    const node = nodes.get(key)!;
    if (node.declaredOnly) add("not started");
    for (const m of node.members) {
      const s = jobStatus(m.job);
      add(s === "success" || s === "neutral" ? "succeeded" : s === "failure" || s === "timed_out" ? "failed" : s === "in_progress" || s === "queued" ? "running" : s === "waiting" ? "waiting" : s === "skipped" ? "skipped" : s);
    }
  }
  return ["succeeded", "failed", "cancelled", "running", "waiting", "skipped", "not started"]
    .filter((k) => counts.get(k))
    .map((k) => `${counts.get(k)} ${k}`)
    .join(" · ");
}

export function gateText(gate: NonNullable<Phase["gate"]>): string {
  if (gate.state === "approved") return `Approved${gate.by ? ` by ${gate.by}` : ""}`;
  if (gate.state === "rejected") return `Rejected${gate.by ? ` by ${gate.by}` : ""}`;
  return `Awaiting approval${gate.reviewers?.length ? ` · ${gate.reviewers.join(", ")}` : ""}`;
}

type Props = {
  overview: Overview;
  graph: RunGraph;
  selectedPhase?: string;
  onSelectPhase(id: string): void;
  onShowJob(nodeKey: string): void;
};

export function ReleaseOverview({ overview, graph, selectedPhase, onSelectPhase, onShowJob }: Props) {
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const phases = overview.phases;
  const byId = new Map(phases.map((p) => [p.id, p]));
  const linked = (a: string, b: string) => overview.phaseEdges.some((e) => e.from === a && e.to === b);
  const stop = overview.stop;
  return (
    <section className="release" aria-labelledby="release-heading" data-testid="release-overview">
      <h3 id="release-heading" className="visually-hidden">
        Release overview
      </h3>
      {stop && (
        <div className={`stop-banner stop-${stop.kind}`} role="status" data-testid="stop-banner">
          <p>{stop.text}</p>
          <div className="stop-actions">
            {stop.rootCauseKeys[0] && (
              <button className="primary" onClick={() => onShowJob(stop.rootCauseKeys[0]!)}>
                Show the failed job
              </button>
            )}
            {stop.phaseId && stop.phaseId !== selectedPhase && <button onClick={() => onSelectPhase(stop.phaseId!)}>Open {byId.get(stop.phaseId)?.name}</button>}
          </div>
        </div>
      )}
      <ol className="phase-rail" data-testid="phase-rail">
        {phases.map((p, i) => {
          const next = phases[i + 1];
          const duration = durationMs(p.startedAt, p.completedAt);
          const firstFailed = p.failedKeys.map((k) => nodes.get(k)!).find(Boolean);
          return (
            <li key={p.id} className="phase-cell">
              <button
                className={`phase-card ps-${p.status}${p.id === selectedPhase ? " selected" : ""}`}
                aria-expanded={p.id === selectedPhase}
                aria-controls="phase-detail"
                onClick={() => onSelectPhase(p.id)}
                data-testid={`phase-${p.id}`}
              >
                <span className="pc-head">
                  <span className="pc-name">{p.name}</span>
                  <span className="pc-kind">{p.kind === "deploy" && p.environment ? `deploy · ${p.environment}` : p.kind}</span>
                </span>
                <PhaseBadge status={p.status} />
                <ProgressBar phase={p} nodes={nodes} />
                <span className="pc-line" data-testid={`phase-${p.id}-counts`}>
                  {breakdown(p, nodes)}
                  {duration !== undefined ? ` · ${formatDuration(duration)}` : ""}
                </span>
                {p.gate && <span className={`pc-line gate g-${p.gate.state}`}>{gateText(p.gate)}</span>}
                {firstFailed && <span className="pc-line pc-failed">✕ {firstFailed.label}</span>}
                {p.recovery === "succeeded" && <span className="pc-line pc-recovery">↩ rollback succeeded</span>}
                {p.recovery === "failed" && <span className="pc-line pc-failed">↩ rollback failed</span>}
                {p.recovery === "running" && <span className="pc-line pc-recovery">↩ rolling back</span>}
                {p.blockedBy && (
                  <span className="pc-line pc-blocked">
                    {p.status === "blocked" ? "Blocked by" : "Waiting on"} {p.blockedBy.reason}
                  </span>
                )}
              </button>
              {next && (
                <span className={`phase-link${linked(p.id, next.id) ? "" : " none"}`} title={linked(p.id, next.id) ? "Jobs in the next phase need jobs in this one" : "No direct job dependency between these phases"}>
                  {linked(p.id, next.id) ? "→" : "·"}
                </span>
              )}
            </li>
          );
        })}
        {overview.unassignedKeys.length > 0 && (
          <li className="phase-cell">
            <button className={`phase-card ps-other${selectedPhase === "other" ? " selected" : ""}`} aria-expanded={selectedPhase === "other"} aria-controls="phase-detail" onClick={() => onSelectPhase("other")} data-testid="phase-other">
              <span className="pc-head">
                <span className="pc-name">Other jobs</span>
              </span>
              <span className="pc-line">{overview.unassignedKeys.length} not in any phase</span>
            </button>
          </li>
        )}
      </ol>
      <p className="release-source note" data-testid="phase-source">
        {overview.source === "declared" ? "Declared grouping. " : "Inferred grouping. "}
        {overview.sourceNote} Arrows between phases come from real job dependencies.
        {overview.notes.map((n) => ` ${n}`)}
      </p>
    </section>
  );
}
