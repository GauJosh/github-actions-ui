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
export type Band = { label: string; start: number; size: number };
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
export type LayoutOptions = { bundle?: boolean };

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
