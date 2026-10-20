// The execution graph: HTML job nodes (real buttons, so keyboard and screen readers work) over an SVG edge
// layer. Pan by dragging or with arrow keys; zoom with Ctrl/⌘+scroll, +/− or the toolbar; fit to view.
//
// Readability rules:
// - opens at a readable zoom (fit only if the whole graph stays readable), centred on the failure;
// - optional lanes (declared job groups) and column bands (phases) structure large graphs;
// - "Focused edges" (default): complete many-to-many dependencies are drawn through one junction, and when a
//   job is selected, edges that do not touch it (directly or through a junction) are faded;
// - "All edges": every real edge drawn individually at full strength.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { durationMs, jobStatus as statusFor, type GraphNode, type RunGraph } from "../../domain/graph/build";
import { layoutGraph, type LaidEdge, type Layout } from "../../domain/graph/layout";
import type { GateState, JobRole, RoleEvidence } from "../../domain/phases/phases";
import type { Job } from "../../domain/types";
import { formatDuration } from "../format";
import { STATUS_LABEL, StatusIcon } from "../status";

const MEMBER_ROW = 22;
const MAX_MEMBERS = 6;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;
/** Below this zoom node text is too small to read, so a large graph opens at this zoom on its most relevant node. */
const READABLE_ZOOM = 0.8;
const SUMMARY_WIDTH = 176;

/** Extra context shown on nodes in the release views: roles, approval gates, and opening a reusable call. */
export type NodeAnnotations = {
  roles?: Map<string, { role: JobRole; evidence: RoleEvidence }>;
  gates?: Map<string, GateState>;
  onOpenCall?(node: GraphNode): void;
};

export function nodeHeight(node: GraphNode, options: { callable?: boolean } = {}): number {
  if (node.external) return 58;
  const callRow = node.kind === "reusable" && options.callable ? MEMBER_ROW + 6 : 0;
  if (node.kind === "job") return 70 + callRow;
  const rows = Math.min(node.members.length, MAX_MEMBERS) + (node.members.length > MAX_MEMBERS ? 1 : 0);
  return 70 + Math.max(1, rows) * MEMBER_ROW + 8 + callRow;
}

const ROLE_TEXT: Record<JobRole, string> = {
  build: "build",
  deploy: "deployment",
  validation: "validation",
  approval: "approval gate",
  recovery: "recovery · runs on failure",
  other: "",
};

/** Role and gate facts for a node, e.g. "deployment → stage · approved". */
export function roleText(node: GraphNode, annotations?: NodeAnnotations): string | null {
  const parts: string[] = [];
  const role = annotations?.roles?.get(node.key)?.role;
  if (role && ROLE_TEXT[role]) parts.push(role === "deploy" && node.environment ? `deployment → ${node.environment}` : ROLE_TEXT[role]);
  else if (node.environment) parts.push(`environment: ${node.environment}`);
  const gate = node.environment ? annotations?.gates?.get(node.environment) : undefined;
  if (gate) parts.push(gate.state === "pending" ? "awaiting approval" : gate.state === "approved" ? "approved" : "approval rejected");
  return parts.length ? parts.join(" · ") : null;
}

/** Failures first, so the evidence is visible even when a group is truncated. */
export function orderedMembers(node: GraphNode) {
  const rank = (s: string | null) => (s === "failure" || s === "timed_out" ? 0 : s === "cancelled" ? 1 : 2);
  return [...node.members].sort((a, b) => rank(a.job.conclusion) - rank(b.job.conclusion));
}

export function countsText(node: GraphNode): string {
  if (node.declaredOnly) return "no job in this run";
  if (node.members.length === 1) return STATUS_LABEL[node.status];
  return Object.entries(node.counts)
    .map(([s, n]) => `${n} ${STATUS_LABEL[s as keyof typeof STATUS_LABEL].toLowerCase()}`)
    .join(" · ");
}

export function kindText(node: GraphNode, graph: RunGraph): string | null {
  if (node.kind === "matrix") return `matrix · ${node.members.length} jobs${node.source === "job-name" ? " (grouped by name)" : ""}`;
  if (node.kind === "reusable") return node.source === "job-name" ? "reusable workflow? (grouped by name)" : `calls ${node.uses}`;
  if (node.source === "job-name" && graph.evidence.kind === "workflow-file") return "not matched to the workflow file";
  return null;
}

type View = { x: number; y: number; k: number };
type Size = { w: number; h: number };

function fitView(layout: Layout, size: Size): View {
  const k = Math.min(1, Math.max(MIN_ZOOM, Math.min((size.w - 24) / layout.width, (size.h - 24) / layout.height)));
  return { k, x: (size.w - layout.width * k) / 2, y: Math.max(8, (size.h - layout.height * k) / 2) };
}

/**
 * Fit the whole graph if it stays readable; otherwise open at a readable zoom centred on the first failing,
 * running or waiting node (or the first node). The toolbar's Fit still shows everything.
 */
function initialView(layout: Layout, size: Size, ordered: GraphNode[]): View {
  const fitted = fitView(layout, size);
  if (fitted.k >= READABLE_ZOOM) return fitted;
  const focus =
    ordered.find((n) => !n.external && (n.status === "failure" || n.status === "timed_out")) ??
    ordered.find((n) => !n.external && (n.status === "in_progress" || n.status === "waiting" || n.status === "queued")) ??
    ordered[0];
  const b = focus ? layout.boxes.get(focus.key) : undefined;
  if (!b) return fitted;
  const k = READABLE_ZOOM;
  return { k, x: Math.min(16, size.w / 2 - (b.x + b.width / 2) * k), y: Math.min(16, size.h / 2 - (b.y + b.height / 2) * k) };
}

type Props = {
  graph: RunGraph;
  selectedKey?: string;
  selectedJobId?: number;
  onSelectNode(node: GraphNode): void;
  onSelectJob(job: Job, node: GraphNode): void;
  annotations?: NodeAnnotations;
  /** Accessible name for the canvas, e.g. "Stage phase". */
  label?: string;
  /** Size the viewport to the graph (up to a maximum) instead of a fixed height. */
  fitContent?: boolean;
  /** Declared job groups (node key → label), drawn as swimlanes. */
  lanes?: Map<string, string>;
  /** Phase of each node (node key → name), labelled across the top when phases occupy separate columns. */
  columns?: Map<string, string>;
};

export function GraphCanvas({ graph, selectedKey, selectedJobId, onSelectNode, onSelectJob, annotations, label, fitContent, lanes, columns }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [expanded, setExpanded] = useState(false);
  const [allEdges, setAllEdges] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const callable = Boolean(annotations?.onOpenCall);
  const layout = useMemo(
    () =>
      layoutGraph(
        graph.nodes.map((n) => ({
          key: n.key,
          height: nodeHeight(n, { callable }),
          width: n.external ? SUMMARY_WIDTH : undefined,
          lane: lanes?.get(n.key),
          column: columns?.get(n.key),
          float: Boolean(n.external),
        })),
        graph.edges,
        { bundle: !allEdges },
      ),
    [graph, callable, lanes, columns, allEdges],
  );

  const ordered = useMemo(
    () =>
      [...graph.nodes].sort((a, b) => {
        const A = layout.boxes.get(a.key)!;
        const B = layout.boxes.get(b.key)!;
        return A.layer - B.layer || A.y - B.y;
      }),
    [graph.nodes, layout],
  );

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (size.w && size.h) setView(fitView(layout, size));
  }, [layout, size]);

  // Initial view, once per graph and as soon as the viewport has a size (computed during render).
  const [viewFor, setViewFor] = useState<RunGraph | null>(null);
  if (viewFor !== graph && size.w && size.h) {
    setViewFor(graph);
    setView(initialView(layout, size, ordered));
  }

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);

  // Ctrl/⌘ + wheel (and trackpad pinch) zooms; a plain wheel keeps scrolling the page.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /** Moves the view just enough to show a node (used for keyboard focus and list selection). */
  const reveal = useCallback(
    (key: string) => {
      const b = layout.boxes.get(key);
      if (!b || !size.w) return;
      setView((v) => {
        const left = b.x * v.k + v.x;
        const top = b.y * v.k + v.y;
        const right = left + b.width * v.k;
        const bottom = top + b.height * v.k;
        if (left >= 0 && top >= 0 && right <= size.w && bottom <= size.h) return v;
        return { ...v, x: size.w / 2 - (b.x + b.width / 2) * v.k, y: size.h / 2 - (b.y + b.height / 2) * v.k };
      });
    },
    [layout, size],
  );

  // Bring a newly selected node into view (selection can come from the job list, outside the graph).
  const [revealedKey, setRevealedKey] = useState(selectedKey);
  if (selectedKey !== revealedKey) {
    setRevealedKey(selectedKey);
    if (selectedKey) reveal(selectedKey);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target !== viewport.current) return;
    const step = 60;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key]!;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else if (e.key === "+" || e.key === "=") zoomAt(1.2, size.w / 2, size.h / 2);
    else if (e.key === "-") zoomAt(1 / 1.2, size.w / 2, size.h / 2);
    else if (e.key === "0") fit();
  }

  // Relationships of the selection, including those drawn through a junction.
  const junctions = useMemo(() => new Map(layout.junctions.map((j) => [j.id, j])), [layout]);
  const edgeRelated = (e: LaidEdge) => {
    if (!selectedKey) return false;
    if (e.from === selectedKey || e.to === selectedKey) return true;
    const j = e.junction ? junctions.get(e.junction) : undefined;
    if (!j) return false;
    if (j.sources.includes(selectedKey)) return e.from.startsWith("junction:");
    if (j.targets.includes(selectedKey)) return e.to.startsWith("junction:");
    return false;
  };
  const related = new Set<string>();
  if (selectedKey) {
    for (const e of graph.edges) {
      if (e.from === selectedKey) related.add(e.to);
      if (e.to === selectedKey) related.add(e.from);
    }
  }
  const statusOf = new Map(graph.nodes.map((n) => [n.key, n.status]));
  const large = graph.nodes.length > 12 && (layout.width > size.w * 1.3 || layout.height > size.h * 1.3);
  const maxHeight = expanded ? undefined : fitContent ? Math.min(620, Math.max(180, layout.height + 24)) : undefined;

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar" role="toolbar" aria-label="Graph view">
        <button onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)} aria-label="Zoom out">
          −
        </button>
        <span className="zoom-level" aria-live="polite">
          {Math.round(view.k * 100)}%
        </span>
        <button onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)} aria-label="Zoom in">
          +
        </button>
        <button onClick={fit}>Fit</button>
        <button onClick={() => setView((v) => ({ ...v, k: 1 }))}>100%</button>
        <button onClick={() => setExpanded((x) => !x)} aria-pressed={expanded}>
          {expanded ? "Compact" : "Expand"}
        </button>
        <span className="edge-mode" role="group" aria-label="Edges">
          <span className="muted">Edges:</span>
          <button aria-pressed={!allEdges} onClick={() => setAllEdges(false)} title="Bundle complete many-to-many dependencies and fade edges unrelated to the selected job">
            Focused
          </button>
          <button aria-pressed={allEdges} onClick={() => setAllEdges(true)} title="Draw every dependency edge individually">
            Show all edges
          </button>
        </span>
        {large && size.w > 0 && <Minimap graph={graph} layout={layout} view={view} size={size} onMove={(x, y) => setView((v) => ({ ...v, x: size.w / 2 - x * v.k, y: size.h / 2 - y * v.k }))} />}
        <span className="muted hint">Drag to pan · Ctrl/⌘+scroll to zoom</span>
      </div>
      <div
        ref={viewport}
        className={`graph-viewport${expanded ? " expanded" : ""}${selectedKey && !allEdges ? " focusing" : ""}`}
        style={maxHeight ? { height: maxHeight } : undefined}
        tabIndex={0}
        role="group"
        aria-label={`${label ?? "Execution graph"}: ${graph.nodes.length} nodes, ${graph.edges.length} dependency edges`}
        data-testid="graph-viewport"
        data-edge-mode={allEdges ? "all" : "focused"}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest(".gnode")) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <div className="graph-stage" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {layout.columns.map((c) => (
            <div key={c.label} className="column-band" style={{ left: c.start, width: c.size, height: layout.height }} data-testid="column-band">
              <span>{c.label}</span>
            </div>
          ))}
          {layout.lanes.map((band) => (
            <div key={band.label} className="lane-band" style={{ top: band.start, height: band.size, width: layout.width }} data-testid="lane-band">
              <span>{band.label}</span>
            </div>
          ))}
          <svg className="graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const target = statusOf.get(e.to);
              const hl = edgeRelated(e);
              const cls = ["edge", hl ? "hl" : selectedKey && !allEdges ? "faded" : "", target === "skipped" || target === "not_run" ? "muted" : "", e.junction ? "bundled" : ""].join(" ");
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={e.path}
                  className={cls}
                  markerEnd={e.to.startsWith("junction:") ? undefined : "url(#arrow)"}
                  data-from={e.from}
                  data-to={e.to}
                  data-testid="graph-edge"
                />
              );
            })}
            {layout.junctions.map((j) => (
              <g key={j.id} className="junction" data-testid="graph-junction">
                <circle cx={j.x} cy={j.y} r={6} />
                <title>{`Junction: each of these ${j.sources.length} jobs is needed by each of these ${j.targets.length} jobs (${j.sources.length * j.targets.length} dependencies drawn as ${j.sources.length + j.targets.length} lines).`}</title>
              </g>
            ))}
          </svg>
          {ordered.map((node) => (
            <NodeView
              key={node.key}
              node={node}
              graph={graph}
              box={layout.boxes.get(node.key)!}
              selected={node.key === selectedKey}
              related={related.has(node.key) && node.key !== selectedKey}
              dimmed={Boolean(selectedKey) && !allEdges && node.key !== selectedKey && !related.has(node.key)}
              selectedJobId={selectedJobId}
              onSelectNode={onSelectNode}
              onSelectJob={onSelectJob}
              onFocus={() => reveal(node.key)}
              annotations={annotations}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function NodeView({
  node,
  graph,
  box,
  selected,
  related,
  dimmed,
  selectedJobId,
  onSelectNode,
  onSelectJob,
  onFocus,
  annotations,
}: {
  node: GraphNode;
  graph: RunGraph;
  box: { x: number; y: number; width: number; height: number };
  selected: boolean;
  related: boolean;
  dimmed: boolean;
  selectedJobId?: number;
  onSelectNode(node: GraphNode): void;
  onSelectJob(job: Job, node: GraphNode): void;
  onFocus(): void;
  annotations?: NodeAnnotations;
}) {
  if (node.external) {
    const ext = node.external;
    const jobs = ext.jobs ?? [];
    const upstream = ext.direction !== "downstream";
    const what = upstream ? `${jobs.length} prerequisite job${jobs.length === 1 ? "" : "s"}` : `${jobs.length} dependent job${jobs.length === 1 ? "" : "s"}`;
    return (
      <div
        className={`gnode external s-${node.status}${related ? " related" : ""}${dimmed ? " dimmed" : ""}`}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        data-testid="graph-node"
        data-node-key={node.key}
        data-status={node.status}
        title={`${upstream ? "In" : "Needed by jobs in"} ${ext.phaseName}: ${jobs.join(", ")}`}
      >
        <button className="gnode-main" onClick={() => onSelectNode(node)} onFocus={onFocus} aria-label={`${what} in ${ext.phaseName}: ${jobs.join(", ")}. Go to ${ext.phaseName}.`}>
          <span className="gnode-title">
            <span className="gnode-name">{upstream ? `← ${ext.phaseName}` : `${ext.phaseName} →`}</span>
          </span>
          <span className="gnode-meta">
            <span>{what}</span>
          </span>
        </button>
      </div>
    );
  }
  const kind = [kindText(node, graph), roleText(node, annotations)].filter(Boolean).join(" · ") || null;
  const duration = node.status === "skipped" || node.status === "not_run" ? undefined : durationMs(node.startedAt, node.completedAt);
  const members = orderedMembers(node);
  const classes = [
    "gnode",
    `k-${node.kind}`,
    `s-${node.status}`,
    selected ? "selected" : "",
    related ? "related" : "",
    dimmed ? "dimmed" : "",
    node.declaredOnly ? "declared" : "",
    node.source === "job-name" && graph.evidence.kind === "workflow-file" ? "unmatched" : "",
  ].join(" ");
  return (
    <div className={classes} style={{ left: box.x, top: box.y, width: box.width, height: box.height }} data-testid="graph-node" data-node-key={node.key} data-status={node.status}>
      <button
        className="gnode-main"
        onClick={() => onSelectNode(node)}
        onFocus={onFocus}
        aria-pressed={selected}
        aria-label={`${node.label}: ${countsText(node)}${kind ? `, ${kind}` : ""}${duration !== undefined ? `, ${formatDuration(duration)}` : ""}`}
      >
        <span className="gnode-title">
          <StatusIcon status={node.status} />
          <span className="gnode-name">{node.label}</span>
        </span>
        <span className="gnode-meta">
          <span>{countsText(node)}</span>
          {duration !== undefined && <span>{formatDuration(duration)}</span>}
          {node.status === "in_progress" && <span>running</span>}
        </span>
        {kind && <span className="gnode-kind">{kind}</span>}
      </button>
      {node.kind !== "job" && (
        <ul className="gnode-members">
          {members.slice(0, MAX_MEMBERS).map((m) => (
            <li key={m.job.id}>
              <button className={`member s-${statusFor(m.job)}`} aria-pressed={m.job.id === selectedJobId} onClick={() => onSelectJob(m.job, node)} onFocus={onFocus}>
                <StatusIcon status={statusFor(m.job)} />
                <span className="member-label">{m.label}</span>
              </button>
            </li>
          ))}
          {members.length > MAX_MEMBERS && <li className="more">+{members.length - MAX_MEMBERS} more (see job list)</li>}
          {members.length === 0 && <li className="more">no job in this run</li>}
        </ul>
      )}
      {node.kind === "reusable" && annotations?.onOpenCall && (
        <button className="open-call" onClick={() => annotations.onOpenCall!(node)} onFocus={onFocus}>
          Open called workflow ▸
        </button>
      )}
    </div>
  );
}

const MINI_W = 150;
const MINI_H = 34;

/** A small overview strip in the toolbar (orientation aid only; the main view stays readable). */
function Minimap({ graph, layout, view, size, onMove }: { graph: RunGraph; layout: Layout; view: View; size: Size; onMove(x: number, y: number): void }) {
  const s = Math.min(MINI_W / layout.width, MINI_H / layout.height);
  return (
    <svg
      className="minimap"
      width={layout.width * s}
      height={layout.height * s}
      role="img"
      aria-label="Minimap of the whole graph; click to move the view"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onMove((e.clientX - r.left) / s, (e.clientY - r.top) / s);
      }}
    >
      {graph.nodes.map((n) => {
        const b = layout.boxes.get(n.key)!;
        return <rect key={n.key} x={b.x * s} y={b.y * s} width={b.width * s} height={b.height * s} className={`mini s-${n.status}`} />;
      })}
      <rect className="mini-view" x={(-view.x / view.k) * s} y={(-view.y / view.k) * s} width={(size.w / view.k) * s} height={(size.h / view.k) * s} />
    </svg>
  );
}
