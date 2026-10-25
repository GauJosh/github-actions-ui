// Line diff: exact edit scripts, the edit cap, coarse differences and hunks.
import { describe, expect, it } from "vitest";
import { countDifferences, diffSequences, hunks, type DiffOp } from "./diff";

/** Applies an edit script to `a`, which must give `b`. */
function apply(a: string[], b: string[], ops: DiffOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === "equal") out.push(...a.slice(op.a, op.a + op.length));
    if (op.kind === "add") out.push(...b.slice(op.b, op.b + op.length));
  }
  return out;
}

describe("diffSequences", () => {
  it("produces a minimal script that turns a into b", () => {
    const a = "a b c a b b a".split(" ");
    const b = "c b a b a c".split(" ");
    const r = diffSequences(a, b);
    if ("tooLarge" in r) throw new Error("unexpected");
    expect(apply(a, b, r.ops)).toEqual(b);
    expect(r.ops.filter((o) => o.kind !== "equal").reduce((s, o) => s + o.length, 0)).toBe(5); // the classic example: D = 5
  });

  it("handles identical, empty and one-sided inputs", () => {
    expect(diffSequences(["x"], ["x"])).toEqual({ ops: [{ kind: "equal", a: 0, b: 0, length: 1 }], edits: 0 });
    expect(diffSequences([], ["x", "y"])).toEqual({ ops: [{ kind: "add", a: 0, b: 0, length: 2 }], edits: 2 });
    const r = diffSequences(["k", "x", "k"], ["k", "k"]);
    expect(r).toEqual({ ops: [{ kind: "equal", a: 0, b: 0, length: 1 }, { kind: "remove", a: 1, b: 1, length: 1 }, { kind: "equal", a: 2, b: 1, length: 1 }], edits: 1 });
  });

  it("is correct on random inputs and works on numeric fingerprints", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % 5);
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: rnd() * 4 }, () => String(rnd()));
      const b = Array.from({ length: rnd() * 4 }, () => String(rnd()));
      const r = diffSequences(a, b);
      if ("tooLarge" in r) throw new Error("unexpected");
      expect(apply(a, b, r.ops)).toEqual(b);
    }
    const r = diffSequences(Uint32Array.from([1, 2, 3]), Uint32Array.from([1, 9, 3]));
    expect("ops" in r && r.ops.map((o) => o.kind)).toEqual(["equal", "remove", "add", "equal"]);
  });

  it("stops at the edit cap instead of running unbounded", () => {
    const a = Array.from({ length: 500 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 500 }, (_, i) => `b${i}`);
    expect(diffSequences(a, b, 100)).toMatchObject({ tooLarge: true });
    expect(countDifferences(["x", "y", "y"], ["y", "z"])).toEqual({ onlyA: [0, 2], onlyB: [1] });
  });

  it("groups changes into hunks with context", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = [...a];
    b[5] = "changed";
    b.splice(25, 0, "inserted");
    const r = diffSequences(a, b);
    if ("tooLarge" in r) throw new Error("unexpected");
    const h = hunks(r.ops, 2);
    expect(h.map((x) => [x.a, x.b])).toEqual([
      [[3, 8], [3, 8]],
      [[23, 27], [23, 28]],
    ]);
  });
});
