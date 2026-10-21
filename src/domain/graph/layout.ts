// Layered left-to-right layout for a run graph. Pure and deterministic.
//
// - Layers follow dependency edges only (longest path from a source). Without edges, nodes form a plain grid.
// - Optional lanes (e.g. services declared in the repository's phase file) keep related jobs on one row band.
// - Optional column groups (e.g. phases) are labelled when their layers do not overlap.
// - Edges are routed through gaps between nodes in intermediate layers, not behind them.
// - Optional bundling: when several jobs in one layer need exactly the same set of 2+ jobs (every source is
//   needed by every target), their edges meet at one junction instead of crossing as a full mesh. It draws
//   the same relationships with fewer lines; nothing is added or removed.

/** `float`: not part of any lane; centred vertically in its column (used for summaries of neighbouring phases). */
export type LayoutNode = { key: string; height: number; width?: number; lane?: string; column?: string; float?: boolean };
export type LayoutEdge = { from: string; to: string };
export type Box = { x: number; y: number; width: number; height: number; layer: number };
export type LaidEdge = { from: string; to: string; path: string; junction?: string };
export type Junction = { id: string; x: number; y: number; sources: string[]; targets: string[] };
/** A lane or column band. `x`/`width`: a lane limited to one group (grouped layout). */
export type Band = { label: string; start: number; size: number; x?: number; width?: number };
export type Layout = {
  boxes: Map<string, Box>;
  edges: LaidEdge[];
  junctions: Junction[];
  lanes: Band[];
  columns: Band[];
  width: number;
  height: number;
  cyclic: boolean;
};
/** `vertical` (grouped layout): each group is a column, its jobs top to bottom in dependency order. */
export type LayoutOptions = { bundle?: boolean; vertical?: boolean };

export const NODE_WIDTH = 228;
const GAP_X = 64;
const GAP_Y = 18;
const GRID_ROWS = 8;
const PAD = 24;
const LANE_HEADER = 20;
const LANE_GAP = 12;
const COLUMN_HEADER = 24;
const CLEARANCE = 6;

export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], options: LayoutOptions = {}): Layout {
  const keys = new Set(nodes.map((n) => n.key));
  const valid = edges.filter((e) => keys.has(e.from) && keys.has(e.to) && e.from !== e.to);
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  let layers: string[][];
  let cyclic = false;

  const preds = new Map<string, string[]>(nodes.map((n) => [n.key, []]));
  const succs = new Map<string, string[]>(nodes.map((n) => [n.key, []]));
  for (const e of valid) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }

  if (valid.length === 0) {
    layers = [];
    nodes.forEach((n, i) => (layers[Math.floor(i / GRID_ROWS)] ??= []).push(n.key));
  } else {
    const indegree = new Map(nodes.map((n) => [n.key, preds.get(n.key)!.length]));
    const layer = new Map<string, number>();
    const queue = nodes.filter((n) => indegree.get(n.key) === 0).map((n) => n.key);
    queue.forEach((k) => layer.set(k, 0));
    for (let i = 0; i < queue.length; i++) {
      const k = queue[i]!;
      for (const s of succs.get(k)!) {
        layer.set(s, Math.max(layer.get(s) ?? 0, layer.get(k)! + 1));
        indegree.set(s, indegree.get(s)! - 1);
        if (indegree.get(s) === 0) queue.push(s);
      }
    }
    const maxLayer = Math.max(0, ...layer.values());
    for (const n of nodes) {
      if (!layer.has(n.key)) {
        cyclic = true;
        layer.set(n.key, maxLayer + 1);
      }
    }
    // When every node belongs to a column group (e.g. a phase), keep each group in its own range of layers,
    // in the groups' order of appearance. This only shifts nodes right; dependencies are unchanged. If a
    // dependency points from a later group to an earlier one, keep the plain layering.
    const columnOrder: string[] = [];
    for (const n of nodes) if (n.column !== undefined && !columnOrder.includes(n.column)) columnOrder.push(n.column);
    if (!cyclic && columnOrder.length > 1 && nodes.every((n) => n.column !== undefined)) {
      const constrained = new Map<string, number>();
      let base = 0;
      let ok = true;
      for (const c of columnOrder) {
        const members = nodes.filter((n) => n.column === c).map((n) => n.key);
        const pending = new Set(members);
        while (pending.size && ok) {
          const ready = [...pending].filter((k) => preds.get(k)!.every((p) => constrained.has(p) || (!pending.has(p) && constrained.has(p))));
          if (!ready.length) ok = false;
          for (const k of ready) {
            constrained.set(k, Math.max(base, ...preds.get(k)!.map((p) => constrained.get(p)! + 1)));
            pending.delete(k);
          }
        }
        if (!ok) break;
        base = Math.max(...members.map((k) => constrained.get(k)!)) + 1;
      }
      if (ok) for (const [k, l] of constrained) layer.set(k, l);
    }
    layers = [];
    for (const n of nodes) (layers[layer.get(n.key)!] ??= []).push(n.key);
    layers = layers.filter(Boolean);
  }

  // Order within layers: lanes first (declared order), then barycenter sweeps to reduce crossings.
  const laneOrder: string[] = [];
  for (const n of nodes) if (n.lane !== undefined && !laneOrder.includes(n.lane)) laneOrder.push(n.lane);
  const hasLanes = laneOrder.length > 0;
  const laneRank = (k: string) => {
    const lane = byKey.get(k)!.lane;
    return lane === undefined ? laneOrder.length : laneOrder.indexOf(lane);
  };
  const position = new Map<string, number>();
  const record = () => layers.forEach((l) => l.forEach((k, i) => position.set(k, i)));
  record();
  if (valid.length) {
    const sweep = (layerList: string[], neighbours: Map<string, string[]>) => {
      const bary = (k: string) => {
        const ns = neighbours.get(k)!.filter((n) => position.has(n));
        return ns.length ? ns.reduce((sum, n) => sum + position.get(n)!, 0) / ns.length : position.get(k)!;
      };
      layerList.sort((a, b) => laneRank(a) - laneRank(b) || bary(a) - bary(b) || index.get(a)! - index.get(b)!);
    };
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < layers.length; i++) {
        sweep(layers[i]!, preds);
        record();
      }
      for (let i = layers.length - 2; i >= 0; i--) {
        sweep(layers[i]!, succs);
        record();
      }
    }
  } else if (hasLanes) {
    layers.forEach((l) => l.sort((a, b) => laneRank(a) - laneRank(b)));
  }

  // Columns: each layer is as wide as its widest node.
  const widthOf = (k: string) => byKey.get(k)!.width ?? NODE_WIDTH;
  const heightOf = (k: string) => byKey.get(k)!.height;
  const colWidth = layers.map((l) => Math.max(...l.map(widthOf)));
  const colX: number[] = [];
  let x = PAD;
  for (const w of colWidth) {
    colX.push(x);
    x += w + GAP_X;
  }

  // Column groups: label a group only when its layers form one contiguous range not shared with another group.
  const columnBands: Band[] = [];
  const groupLayers = new Map<string, Set<number>>();
  layers.forEach((l, li) =>
    l.forEach((k) => {
      const c = byKey.get(k)!.column;
      if (c) (groupLayers.get(c) ?? groupLayers.set(c, new Set()).get(c)!).add(li);
    }),
  );
  const owner = new Map<number, string>();
  let columnsClean = groupLayers.size > 0;
  for (const [g, ls] of groupLayers)
    for (const l of ls) {
      if (owner.has(l) && owner.get(l) !== g) columnsClean = false;
      owner.set(l, g);
    }
  if (columnsClean) {
    for (const [g, ls] of groupLayers) {
      const lo = Math.min(...ls);
      const hi = Math.max(...ls);
      columnBands.push({ label: g, start: colX[lo]! - GAP_X / 2 + 4, size: colX[hi]! + colWidth[hi]! - colX[lo]! + GAP_X - 8 });
    }
  }
  const top = PAD + (columnBands.length ? COLUMN_HEADER : 0);

  // Vertical placement.
  const boxes = new Map<string, Box>();
  const laneBands: Band[] = [];
  const stack = (keysInCell: string[]) => keysInCell.reduce((s, k) => s + heightOf(k), 0) + GAP_Y * Math.max(0, keysInCell.length - 1);
  if (hasLanes) {
    const lanes = [...laneOrder, undefined];
    let y = top;
    for (const lane of lanes) {
      const cells = layers.map((l) => l.filter((k) => byKey.get(k)!.lane === lane && !byKey.get(k)!.float));
      const bandInner = Math.max(0, ...cells.map(stack));
      if (bandInner === 0) continue;
      const bandTop = y;
      const inner = bandTop + LANE_HEADER;
      cells.forEach((cell, li) => {
        let cy = inner + (bandInner - stack(cell)) / 2;
        for (const k of cell) {
          boxes.set(k, { x: colX[li]! + (colWidth[li]! - widthOf(k)) / 2, y: cy, width: widthOf(k), height: heightOf(k), layer: li });
          cy += heightOf(k) + GAP_Y;
        }
      });
      laneBands.push({ label: lane ?? "Other jobs", start: bandTop, size: LANE_HEADER + bandInner + 8 });
      y = bandTop + LANE_HEADER + bandInner + 8 + LANE_GAP;
    }
    // Floating nodes sit beside the lanes, centred on the whole content.
    const middle = (top + y) / 2;
    layers.forEach((l, li) => {
      const floats = l.filter((k) => byKey.get(k)!.float);
      let fy = middle - stack(floats) / 2;
      for (const k of floats) {
        boxes.set(k, { x: colX[li]! + (colWidth[li]! - widthOf(k)) / 2, y: fy, width: widthOf(k), height: heightOf(k), layer: li });
        fy += heightOf(k) + GAP_Y;
      }
    });
  } else {
    const tallest = Math.max(0, ...layers.map(stack));
    layers.forEach((l, li) => {
      let y = top + (valid.length ? (tallest - stack(l)) / 2 : 0);
      for (const k of l) {
        boxes.set(k, { x: colX[li]! + (colWidth[li]! - widthOf(k)) / 2, y, width: widthOf(k), height: heightOf(k), layer: li });
        y += heightOf(k) + GAP_Y;
      }
    });
  }

  // Bundling: targets in one layer with an identical predecessor set of 2+ jobs share a junction.
  const junctions: Junction[] = [];
  const viaJunction = new Set<string>();
  if (options.bundle) {
    const groups = new Map<string, string[]>();
    for (const n of nodes) {
      const ps = [...new Set(preds.get(n.key)!)].sort();
      if (ps.length < 2) continue;
      const sig = `${boxes.get(n.key)!.layer}|${ps.join("\u0000")}`;
      (groups.get(sig) ?? groups.set(sig, []).get(sig)!).push(n.key);
    }
    for (const [sig, targets] of groups) {
      if (targets.length < 2) continue;
      const sources = sig.split("|")[1]!.split("\u0000");
      const layerIdx = boxes.get(targets[0]!)!.layer;
      const centre = (k: string) => boxes.get(k)!.y + boxes.get(k)!.height / 2;
      const ys = [...sources, ...targets].map(centre);
      const id = `j${junctions.length + 1}`;
      junctions.push({ id, x: colX[layerIdx]! - GAP_X / 2, y: ys.reduce((a, b) => a + b, 0) / ys.length, sources, targets });
      for (const s of sources) for (const t of targets) viaJunction.add(`${s}\u0000${t}`);
    }
  }

  // Ports: spread each node's endpoints along its side, ordered by the other end's position.
  const centreOf = (k: string) => (boxes.has(k) ? boxes.get(k)!.y + boxes.get(k)!.height / 2 : junctions.find((j) => j.id === k)!.y);
  type Segment = { from: string; to: string; junction?: string };
  const segments: Segment[] = [];
  for (const e of valid) if (!viaJunction.has(`${e.from}\u0000${e.to}`)) segments.push(e);
  for (const j of junctions) {
    for (const s of j.sources) segments.push({ from: s, to: `junction:${j.id}`, junction: j.id });
    for (const t of j.targets) segments.push({ from: `junction:${j.id}`, to: t, junction: j.id });
  }
  const jById = new Map(junctions.map((j) => [`junction:${j.id}`, j]));
  const outs = new Map<string, Segment[]>();
  const ins = new Map<string, Segment[]>();
  for (const s of segments) {
    if (!jById.has(s.from)) (outs.get(s.from) ?? outs.set(s.from, []).get(s.from)!).push(s);
    if (!jById.has(s.to)) (ins.get(s.to) ?? ins.set(s.to, []).get(s.to)!).push(s);
  }
  const yOfEnd = (k: string) => (jById.has(k) ? jById.get(k)!.y : centreOf(k));
  outs.forEach((list) => list.sort((p, q) => yOfEnd(p.to) - yOfEnd(q.to)));
  ins.forEach((list) => list.sort((p, q) => yOfEnd(p.from) - yOfEnd(q.from)));
  const port = (b: Box, i: number, n: number) => b.y + 10 + ((b.height - 20) * (i + 1)) / (n + 1);

  // Free vertical gaps in a column, for routing edges that pass through it.
  const gapsOf = (li: number): [number, number][] => {
    const bs = layers[li]!.map((k) => boxes.get(k)!).sort((a, b) => a.y - b.y);
    const gaps: [number, number][] = [];
    let cursor = -Infinity;
    for (const b of bs) {
      gaps.push([cursor, b.y - CLEARANCE]);
      cursor = b.y + b.height + CLEARANCE;
    }
    gaps.push([cursor, Infinity]);
    return gaps.filter(([a, b]) => b > a);
  };
  const gapCache = new Map<number, [number, number][]>();
  const throughColumn = (li: number, want: number) => {
    const gaps = gapCache.get(li) ?? gapCache.set(li, gapsOf(li)).get(li)!;
    let best = want;
    let bestDist = Infinity;
    for (const [a, b] of gaps) {
      const y = Math.min(Math.max(want, a + 4), b - 4);
      if (Math.abs(y - want) < bestDist) [best, bestDist] = [y, Math.abs(y - want)];
    }
    return best;
  };
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(16, (x2 - x1) / 2);
    return `C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  const laid: LaidEdge[] = segments.map((s) => {
    const fromJ = jById.get(s.from);
    const toJ = jById.get(s.to);
    const a = fromJ ? undefined : boxes.get(s.from)!;
    const b = toJ ? undefined : boxes.get(s.to)!;
    const x1 = fromJ ? fromJ.x : a!.x + a!.width;
    const y1 = fromJ ? fromJ.y : port(a!, outs.get(s.from)!.indexOf(s), outs.get(s.from)!.length);
    const x2 = toJ ? toJ.x : b!.x;
    const y2 = toJ ? toJ.y : port(b!, ins.get(s.to)!.indexOf(s), ins.get(s.to)!.length);
    const startLayer = a ? a.layer : layers.findIndex((_, li) => colX[li]! > x1) - 1;
    const endLayer = b ? b.layer : layers.findIndex((_, li) => colX[li]! > x2);
    let path = `M ${x1} ${y1}`;
    let cx = x1;
    let cy = y1;
    for (let li = startLayer + 1; li < endLayer; li++) {
      const t = (colX[li]! + colWidth[li]! / 2 - x1) / Math.max(1, x2 - x1);
      const y = throughColumn(li, y1 + (y2 - y1) * t);
      path += ` ${curve(cx, cy, colX[li]! - 8, y)} L ${colX[li]! + colWidth[li]! + 8} ${y}`;
      cx = colX[li]! + colWidth[li]! + 8;
      cy = y;
    }
    path += ` ${curve(cx, cy, x2, y2)}`;
    return { from: s.from, to: s.to, path, junction: s.junction };
  });

  const lastBand = laneBands.at(-1);
  const contentBottom = hasLanes && lastBand ? lastBand.start + lastBand.size : Math.max(top, ...[...boxes.values()].map((bx) => bx.y + bx.height));
  return {
    boxes,
    edges: laid,
    junctions,
    lanes: laneBands,
    columns: columnBands,
    width: x - GAP_X + PAD,
    height: contentBottom + PAD,
    cyclic,
  };
}

// ---- grouped (compound) layout ---------------------------------------------------------------------
//
// Each group (e.g. an environment) is laid out on its own, by the dependencies inside it, and drawn as one framed
// subgraph. Groups are then placed left to right by the dependencies between them, so groups that do not depend
// on each other (PROD and PROD-DR after the same gate) stand side by side vertically instead of in one long row.
// Nodes without a group are placed the same way, without a frame. Edges are the same as in the plain layout.

export type GroupFrame = { label: string; x: number; y: number; width: number; height: number };
const FRAME_PAD = 14;
const FRAME_HEADER = 26;
const GROUP_GAP_X = 72;
const GROUP_GAP_Y = 28;

const NUMBER_PAIR = /(-?\d+(?:\.\d+)?(?:e-?\d+)?) (-?\d+(?:\.\d+)?(?:e-?\d+)?)/g;
const shiftPath = (path: string, dx: number, dy: number) => path.replace(NUMBER_PAIR, (_, x: string, y: string) => `${Number(x) + dx} ${Number(y) + dy}`);

/** Lays out nodes grouped by `column` (the group label). Falls back to the plain layout if groups depend on each other in a cycle. */
export function layoutGrouped(nodes: LayoutNode[], edges: LayoutEdge[], options: LayoutOptions = {}): Layout & { groups: GroupFrame[] } {
  const keys = new Set(nodes.map((n) => n.key));
  const valid = edges.filter((e) => keys.has(e.from) && keys.has(e.to) && e.from !== e.to);
  const groupOf = new Map(nodes.map((n) => [n.key, n.column ?? `\u0000${n.key}`]));
  const order: string[] = [];
  for (const n of nodes) if (!order.includes(groupOf.get(n.key)!)) order.push(groupOf.get(n.key)!);
  const framed = (g: string) => !g.startsWith("\u0000");

  // Dependencies between groups; a cycle means the grouping cannot be drawn as left-to-right subgraphs.
  const gPreds = new Map(order.map((g) => [g, new Set<string>()]));
  for (const e of valid) {
    const a = groupOf.get(e.from)!;
    const b = groupOf.get(e.to)!;
    if (a !== b) gPreds.get(b)!.add(a);
  }
  const gLayer = new Map<string, number>();
  const visiting = new Set<string>();
  let cyclic = false;
  const visit = (g: string): number => {
    if (gLayer.has(g)) return gLayer.get(g)!;
    if (visiting.has(g)) {
      cyclic = true;
      return 0;
    }
    visiting.add(g);
    const l = Math.max(-1, ...[...gPreds.get(g)!].map(visit)) + 1;
    visiting.delete(g);
    gLayer.set(g, l);
    return l;
  };
  order.forEach(visit);
  if (cyclic) return { ...layoutGraph(nodes, edges, options), groups: [] };

  // Each group on its own.
  const inner = new Map<string, Layout>();
  for (const g of order) {
    const members = nodes.filter((n) => groupOf.get(n.key) === g).map((n) => ({ ...n, column: undefined, float: false }));
    const set = new Set(members.map((m) => m.key));
    const own = valid.filter((e) => set.has(e.from) && set.has(e.to));
    // Declared swimlanes (e.g. services) keep the left-to-right layout inside their group.
    const column = options.vertical && framed(g) && !members.some((m) => m.lane !== undefined);
    inner.set(g, column ? layoutColumn(members, own) : layoutGraph(members, own, options));
  }
  const pad = (g: string) => (framed(g) ? FRAME_PAD : 0);
  const sizeOf = (g: string) => {
    const l = inner.get(g)!;
    // The inner layout has its own outer padding; frames replace it.
    const w = l.width - 2 * PAD + 2 * pad(g);
    const h = l.height - 2 * PAD + 2 * pad(g) + (framed(g) ? FRAME_HEADER : 0);
    return { w: Math.max(w, framed(g) ? 160 : 0), h };
  };

  // Columns of groups; within a column, groups ordered by where their prerequisites are, then appearance.
  const columns: string[][] = [];
  for (const g of order) (columns[gLayer.get(g)!] ??= []).push(g);
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  let x = PAD;
  const colHeights = columns.map((col) => col.reduce((s, g) => s + sizeOf(g).h, 0) + GROUP_GAP_Y * Math.max(0, col.length - 1));
  const tallest = Math.max(0, ...colHeights);
  columns.forEach((col, ci) => {
    const centre = (g: string) => {
      const ps = [...gPreds.get(g)!].map((p) => placed.get(p)).filter((p): p is NonNullable<typeof p> => !!p);
      return ps.length ? ps.reduce((s, p) => s + p.y + p.h / 2, 0) / ps.length : Infinity;
    };
    col.sort((a, b) => {
      const ca = centre(a);
      const cb = centre(b);
      return ca === cb || (ca === Infinity && cb === Infinity) ? order.indexOf(a) - order.indexOf(b) : ca - cb;
    });
    let y = PAD + (tallest - colHeights[ci]!) / 2;
    const width = Math.max(...col.map((g) => sizeOf(g).w));
    for (const g of col) {
      const s = sizeOf(g);
      placed.set(g, { x: x + (width - s.w) / 2, y, w: s.w, h: s.h });
      y += s.h + GROUP_GAP_Y;
    }
    x += width + GROUP_GAP_X;
  });

  // Translate each group's layout into place.
  const boxes = new Map<string, Box>();
  const laid: LaidEdge[] = [];
  const junctions: Junction[] = [];
  const lanes: Band[] = [];
  const frames: GroupFrame[] = [];
  order.forEach((g, gi) => {
    const l = inner.get(g)!;
    const p = placed.get(g)!;
    const dx = p.x + pad(g) - PAD;
    const dy = p.y + pad(g) + (framed(g) ? FRAME_HEADER : 0) - PAD;
    const base = gLayer.get(g)! * 1000;
    for (const [k, b] of l.boxes) boxes.set(k, { ...b, x: b.x + dx, y: b.y + dy, layer: base + b.layer });
    const rename = (id: string) => `g${gi}-${id}`;
    for (const j of l.junctions) junctions.push({ ...j, id: rename(j.id), x: j.x + dx, y: j.y + dy });
    const end = (k: string) => (k.startsWith("junction:") ? `junction:${rename(k.slice("junction:".length))}` : k);
    for (const e of l.edges) laid.push({ ...e, from: end(e.from), to: end(e.to), path: shiftPath(e.path, dx, dy), ...(e.junction ? { junction: rename(e.junction) } : {}) });
    for (const band of l.lanes) lanes.push({ ...band, start: band.start + dy, x: p.x, width: p.w });
    if (framed(g)) frames.push({ label: g, x: p.x, y: p.y, width: p.w, height: p.h });
  });

  // Edges between groups: from the right side of one job to the left side of the other. With bundling, jobs in one
  // group that need exactly the same 2+ jobs elsewhere share a junction just before their group.
  const crossPreds = new Map<string, string[]>();
  for (const e of valid) if (groupOf.get(e.from) !== groupOf.get(e.to)) (crossPreds.get(e.to) ?? crossPreds.set(e.to, []).get(e.to)!).push(e.from);
  const viaJunction = new Set<string>();
  if (options.bundle) {
    const bySig = new Map<string, string[]>();
    for (const [t, ps] of crossPreds) {
      const sources = [...new Set(ps)].sort();
      if (sources.length < 2) continue;
      const sig = `${groupOf.get(t)}|${sources.join("\u0000")}`;
      (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push(t);
    }
    for (const [sig, targets] of bySig) {
      if (targets.length < 2) continue;
      const sources = sig.split("|")[1]!.split("\u0000");
      const frame = placed.get(groupOf.get(targets[0]!)!)!;
      const centre = (k: string) => boxes.get(k)!.y + boxes.get(k)!.height / 2;
      const ys = [...sources, ...targets].map(centre);
      const id = `x${junctions.length + 1}`;
      const j: Junction = { id, x: frame.x - GROUP_GAP_X / 2, y: ys.reduce((s, v) => s + v, 0) / ys.length, sources, targets };
      junctions.push(j);
      for (const s of sources) {
        const a = boxes.get(s)!;
        const [x1, y1] = [a.x + a.width, a.y + a.height / 2];
        const d = Math.max(24, (j.x - x1) / 2);
        laid.push({ from: s, to: `junction:${id}`, junction: id, path: `M ${x1} ${y1} C ${x1 + d} ${y1}, ${j.x - d} ${j.y}, ${j.x} ${j.y}` });
        for (const t of targets) viaJunction.add(`${s}\u0000${t}`);
      }
      for (const t of targets) {
        const b = boxes.get(t)!;
        const [x2, y2] = [b.x, b.y + b.height / 2];
        const d = Math.max(16, (x2 - j.x) / 2);
        laid.push({ from: `junction:${id}`, to: t, junction: id, path: `M ${j.x} ${j.y} C ${j.x + d} ${j.y}, ${x2 - d} ${y2}, ${x2} ${y2}` });
      }
    }
  }
  for (const e of valid) {
    if (groupOf.get(e.from) === groupOf.get(e.to) || viaJunction.has(`${e.from}\u0000${e.to}`)) continue;
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    const [x1, y1, x2, y2] = [a.x + a.width, a.y + a.height / 2, b.x, b.y + b.height / 2];
    const d = Math.max(24, (x2 - x1) / 2);
    laid.push({ from: e.from, to: e.to, path: `M ${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}` });
  }

  const right = Math.max(PAD, ...[...placed.values()].map((p) => p.x + p.w));
  const bottom = Math.max(PAD, ...[...placed.values()].map((p) => p.y + p.h));
  return { boxes, edges: laid, junctions, lanes, columns: [], width: right + PAD, height: bottom + PAD, cyclic: false, groups: frames };
}

const ROW_GAP_X = 20;
const ROW_GAP_Y = 44;

/**
 * Top-to-bottom layout for one group (a column, like a pipeline stage): jobs in dependency order from top to
 * bottom, one row per dependency layer; jobs that can run in parallel share a row. Edges run from the bottom of a
 * job to the top of the job that needs it.
 */
export function layoutColumn(nodes: LayoutNode[], edges: LayoutEdge[]): Layout {
  const flat = layoutGraph(nodes, edges);
  const keys = new Set(nodes.map((n) => n.key));
  const valid = edges.filter((e) => keys.has(e.from) && keys.has(e.to) && e.from !== e.to);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const rows: string[][] = [];
  for (const n of nodes) (rows[flat.boxes.get(n.key)!.layer] ??= []).push(n.key);
  const ordered = rows.filter(Boolean).map((r) => r.sort((a, b) => flat.boxes.get(a)!.y - flat.boxes.get(b)!.y));
  const widthOf = (k: string) => byKey.get(k)!.width ?? NODE_WIDTH;
  const rowWidth = (r: string[]) => r.reduce((s, k) => s + widthOf(k), 0) + ROW_GAP_X * Math.max(0, r.length - 1);
  const inner = Math.max(0, ...ordered.map(rowWidth));
  const boxes = new Map<string, Box>();
  let y = PAD;
  ordered.forEach((r, li) => {
    const h = Math.max(...r.map((k) => byKey.get(k)!.height));
    let x = PAD + (inner - rowWidth(r)) / 2;
    for (const k of r) {
      boxes.set(k, { x, y, width: widthOf(k), height: byKey.get(k)!.height, layer: li });
      x += widthOf(k) + ROW_GAP_X;
    }
    y += h + ROW_GAP_Y;
  });
  // Ports spread along the bottom and top edges, ordered by the other end's position.
  const outs = new Map<string, LayoutEdge[]>();
  const ins = new Map<string, LayoutEdge[]>();
  for (const e of valid) {
    (outs.get(e.from) ?? outs.set(e.from, []).get(e.from)!).push(e);
    (ins.get(e.to) ?? ins.set(e.to, []).get(e.to)!).push(e);
  }
  const cx = (k: string) => boxes.get(k)!.x + boxes.get(k)!.width / 2;
  outs.forEach((l) => l.sort((p, q) => cx(p.to) - cx(q.to)));
  ins.forEach((l) => l.sort((p, q) => cx(p.from) - cx(q.from)));
  const port = (b: Box, i: number, n: number) => b.x + 16 + ((b.width - 32) * (i + 1)) / (n + 1);
  const laid: LaidEdge[] = valid.map((e) => {
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    const x1 = port(a, outs.get(e.from)!.indexOf(e), outs.get(e.from)!.length);
    const y1 = a.y + a.height;
    const x2 = port(b, ins.get(e.to)!.indexOf(e), ins.get(e.to)!.length);
    const y2 = b.y;
    // An edge that skips rows bends out to the side of the column instead of crossing the jobs in between.
    if (b.layer - a.layer > 1) {
      const side = PAD + inner + 14;
      return { from: e.from, to: e.to, path: `M ${x1} ${y1} C ${x1} ${y1 + 20}, ${side} ${y1 + 20}, ${side} ${y1 + 40} L ${side} ${y2 - 40} C ${side} ${y2 - 20}, ${x2} ${y2 - 20}, ${x2} ${y2}` };
    }
    const d = Math.max(14, (y2 - y1) / 2);
    return { from: e.from, to: e.to, path: `M ${x1} ${y1} C ${x1} ${y1 + d}, ${x2} ${y2 - d}, ${x2} ${y2}` };
  });
  const skips = laid.some((e) => e.path.includes(" L "));
  return { boxes, edges: laid, junctions: [], lanes: [], columns: [], width: PAD + inner + (skips ? 28 : 0) + PAD, height: y - ROW_GAP_Y + PAD, cyclic: flat.cyclic };
}
