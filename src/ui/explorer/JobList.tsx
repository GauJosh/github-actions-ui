// Structured job list: the accessible, non-graph way to read and navigate the same run structure.
// Dependencies are written out as text ("needs …"), so nothing depends on seeing the drawing. With a release
// overview, jobs are grouped under their phases.
import { durationMs, jobStatus, type GraphNode, type RunGraph } from "../../domain/graph/build";
import type { Layout } from "../../domain/graph/layout";
import type { Job } from "../../domain/types";
import { formatDuration } from "../format";
import { StatusBadge, StatusIcon } from "../status";
import { countsText, kindText, orderedMembers } from "./GraphCanvas";

type Props = {
  graph: RunGraph;
  layout: Layout;
  selectedKey?: string;
  selectedJobId?: number;
  onSelectNode(node: GraphNode): void;
  onSelectJob(job: Job, node: GraphNode): void;
  sections?: { id: string; title: string; keys: string[] }[];
};

export function JobList({ graph, layout, selectedKey, selectedJobId, onSelectNode, onSelectJob, sections }: Props) {
  const label = new Map(graph.nodes.map((n) => [n.key, n.label]));
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const order = (a: string, b: string) => {
    const A = layout.boxes.get(a)!;
    const B = layout.boxes.get(b)!;
    return A.layer - B.layer || A.y - B.y;
  };
  const groups = sections ?? [{ id: "all", title: "", keys: graph.nodes.map((n) => n.key) }];
  const total = graph.nodes.reduce((n, node) => n + node.members.length, 0);

  const item = (node: GraphNode) => {
    const needs = graph.edges.filter((e) => e.to === node.key).map((e) => label.get(e.from)!);
    const kind = kindText(node, graph);
    const single = node.kind === "job" && node.members.length === 1 ? node.members[0]!.job : undefined;
    return (
      <li key={node.key} className={node.key === selectedKey ? "selected" : ""}>
        <button
          className="jl-node"
          aria-current={single ? (single.id === selectedJobId ? "true" : undefined) : node.key === selectedKey ? "true" : undefined}
          onClick={() => (single ? onSelectJob(single, node) : onSelectNode(node))}
        >
          <StatusBadge status={node.status} compact />
          <span className="jl-name">{node.label}</span>
          <span className="jl-meta">
            {countsText(node)}
            {kind ? ` · ${kind}` : ""}
            {needs.length > 0 ? ` · needs ${needs.join(", ")}` : ""}
          </span>
        </button>
        {node.kind !== "job" && node.members.length > 0 && (
          <ul>
            {orderedMembers(node).map((m) => (
              <li key={m.job.id}>
                <button className="jl-member" aria-current={m.job.id === selectedJobId ? "true" : undefined} onClick={() => onSelectJob(m.job, node)}>
                  <StatusIcon status={jobStatus(m.job)} />
                  <span>{m.label}</span>
                  <span className="muted">{formatDuration(durationMs(m.job.started_at, m.job.completed_at))}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <nav className="panel joblist" aria-label="Jobs in this run" data-testid="job-list">
      <h3>Jobs ({total})</h3>
      <div className="jl-scroll">
        {groups.map((g) => {
          const keys = g.keys.filter((k) => nodes.has(k)).sort(order);
          if (!keys.length) return null;
          return (
            <div key={g.id} className="jl-group">
              {g.title && <h4 className="jl-group-title">{g.title}</h4>}
              <ol>{keys.map((k) => item(nodes.get(k)!))}</ol>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
