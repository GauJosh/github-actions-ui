// Line diff for comparisons (workflow files, logs). Pure: no I/O.
//
// Myers' algorithm over sequences of comparable values (strings, or 32-bit line fingerprints), after trimming the
// common prefix and suffix. The edit count is capped: past `maxEdits` the result says so instead of computing a
// diff that could freeze the page, and `countDifferences` gives lines only in one side as a coarser answer.

export type DiffOp = { kind: "equal" | "remove" | "add"; /** Start in a. */ a: number; /** Start in b. */ b: number; length: number };
export type DiffResult = { ops: DiffOp[]; edits: number } | { tooLarge: true; edits: number };

type Seq = ArrayLike<number | string>;

export function diffSequences(a: Seq, b: Seq, maxEdits = 2000): DiffResult {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const ops: DiffOp[] = [];
  const push = (kind: DiffOp["kind"], ai: number, bi: number, length: number) => {
    if (length <= 0) return;
    const last = ops[ops.length - 1];
    if (last && last.kind === kind && last.a + (kind === "add" ? 0 : last.length) === ai && last.b + (kind === "remove" ? 0 : last.length) === bi) last.length += length;
    else ops.push({ kind, a: ai, b: bi, length });
  };
  push("equal", 0, 0, start);
  if (n === 0 || m === 0) {
    push("remove", start, start, n);
    push("add", start + n, start, m);
    push("equal", endA, endB, a.length - endA);
    return { ops, edits: n + m };
  }
  if (Math.abs(n - m) > maxEdits) return { tooLarge: true, edits: Math.abs(n - m) };

  // Forward Myers, keeping each round's frontier to trace the path back.
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) return { tooLarge: true, edits: max };

  // Back-track: collect the moves from the end, then emit them in order.
  const moves: { kind: DiffOp["kind"]; x: number; y: number; length: number }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!; // frontier before round d, indexed from k = -d - 1
    const at = (k: number) => prev[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    const sx = down ? px : px + 1;
    const sy = sx - k;
    if (x > sx) moves.push({ kind: "equal", x: sx, y: sy, length: x - sx });
    moves.push(down ? { kind: "add", x: px, y: py, length: 1 } : { kind: "remove", x: px, y: py, length: 1 });
    x = px;
    y = py;
  }
  if (x > 0) moves.push({ kind: "equal", x: 0, y: 0, length: x });
  for (const mv of moves.reverse()) push(mv.kind, start + mv.x, start + mv.y, mv.length);
  push("equal", endA, endB, a.length - endA);
  return { ops, edits: found };
}

/** Lines present more often in one side than the other (order ignored): a coarse answer when a diff is too large. */
export function countDifferences(a: Seq, b: Seq): { onlyA: number[]; onlyB: number[] } {
  const counts = new Map<number | string, number>();
  for (let i = 0; i < b.length; i++) counts.set(b[i]!, (counts.get(b[i]!) ?? 0) + 1);
  const onlyA: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const c = counts.get(a[i]!) ?? 0;
    if (c > 0) counts.set(a[i]!, c - 1);
    else onlyA.push(i);
  }
  const left = new Map<number | string, number>();
  for (let i = 0; i < a.length; i++) left.set(a[i]!, (left.get(a[i]!) ?? 0) + 1);
  const onlyB: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = left.get(b[i]!) ?? 0;
    if (c > 0) left.set(b[i]!, c - 1);
    else onlyB.push(i);
  }
  return { onlyA, onlyB };
}

export type Hunk = { a: [number, number]; b: [number, number]; ops: DiffOp[] };

/** Groups changes with `context` equal lines around them into hunks (ranges are [start, end) in each side). */
export function hunks(ops: DiffOp[], context = 3): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  ops.forEach((op, i) => {
    if (op.kind === "equal") {
      if (!cur) return;
      const isLast = i === ops.length - 1;
      if (op.length > context * 2 || isLast) {
        const keep = Math.min(op.length, context);
        cur.ops.push({ ...op, length: keep });
        cur.a[1] = op.a + keep;
        cur.b[1] = op.b + keep;
        out.push(cur);
        cur = null;
      } else {
        cur.ops.push(op);
        cur.a[1] = op.a + op.length;
        cur.b[1] = op.b + op.length;
      }
      return;
    }
    if (!cur) {
      const prev = ops[i - 1];
      const lead = prev?.kind === "equal" ? Math.min(prev.length, context) : 0;
      cur = { a: [op.a - lead, op.a], b: [op.b - lead, op.b], ops: lead ? [{ kind: "equal", a: op.a - lead, b: op.b - lead, length: lead }] : [] };
    }
    cur.ops.push(op);
    cur.a[1] = op.kind === "add" ? op.a : op.a + op.length;
    cur.b[1] = op.kind === "remove" ? op.b : op.b + op.length;
  });
  if (cur) out.push(cur);
  return out;
}
