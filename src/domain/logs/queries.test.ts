// Worker-side log queries: pipeline-wide search excerpts, comparison fingerprints and diffs, and failure evidence
// that survives a large log full of weak matches (SYNTHETIC log text).
import { describe, expect, it } from "vitest";
import { LogStore } from "../../logs/worker/store";
import { diffAgainst, findLines, fingerprints, hashText, normalizeLine } from "./queries";

const store = (lines: string[]) => {
  const s = new LogStore();
  s.append(new TextEncoder().encode(lines.join("\n") + "\n"));
  s.finish();
  s.classify();
  return s;
};
const opts = (query: string, extra: Partial<{ caseSensitive: boolean; wholeWord: boolean }> = {}) => ({ query, caseSensitive: false, wholeWord: false, regex: false, ...extra });

const LOG = [
  "2026-10-21T10:00:00.0000000Z ##[group]Run npm test",
  "2026-10-21T10:00:00.1000000Z ##[endgroup]",
  "2026-10-21T10:00:01.0000000Z running 12 tests",
  "2026-10-21T10:00:02.0000000Z TypeError: Cannot read properties of undefined (reading 'release')",
  "2026-10-21T10:00:02.0000000Z     at notes (/home/runner/work/app/src/releases.js:4:9)",
  "2026-10-21T10:00:02.5000000Z ##[warning]Release notes are empty",
  "2026-10-21T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
];

describe("findLines", () => {
  it("matches case-insensitively by default, exactly when asked, and reports what was searched", () => {
    const s = store(LOG);
    const all = findLines(s, opts("release"), undefined, 100);
    expect("matches" in all && all.matches.map((m) => m.line)).toEqual([3, 4, 5]);
    expect("lines" in all && all.lines).toBe(7);
    const exact = findLines(s, opts("Release", { caseSensitive: true }), undefined, 100);
    expect("matches" in exact && exact.matches.map((m) => m.line)).toEqual([5]);
    const word = findLines(s, opts("release", { wholeWord: true }), undefined, 100);
    expect("matches" in word && word.matches.map((m) => m.line)).toEqual([3, 5]);
  });

  it("filters by line kind (errors, warnings), and with no text lists every line of that kind", () => {
    const s = store(LOG);
    const errors = findLines(s, opts(""), ["error", "error-signature", "test-failed", "error-text"], 100);
    expect("matches" in errors && errors.matches.map((m) => [m.line, m.kind])).toEqual([
      [3, "error-signature"],
      [6, "error"],
    ]);
    const warnings = findLines(s, opts("release"), ["warning", "warning-text"], 100);
    expect("matches" in warnings && warnings.matches.map((m) => m.line)).toEqual([5]);
  });

  it("caps the matches, cuts long lines to an excerpt around the match, and rejects nothing silently", () => {
    const long = `${"x".repeat(1000)} needle ${"y".repeat(1000)}`;
    const s = store([long, ...Array(10).fill("needle")]);
    const r = findLines(s, opts("needle"), undefined, 5);
    if (!("matches" in r)) throw new Error("unexpected");
    expect(r.capped).toBe(true);
    expect(r.matches).toHaveLength(5);
    const first = r.matches[0]!;
    expect(first.text.length).toBeLessThan(260);
    const [a, b] = first.ranges[0]!;
    expect(first.text.slice(a, b)).toBe("needle");
  });
});

describe("log comparison", () => {
  it("normalises what differs between any two runs, and keeps meaningful numbers", () => {
    expect(normalizeLine("2026-10-21T10:00:00.1234567Z Deployed 9f3c2a1b7e in 12.5s at 10:00:03")).toBe("Deployed <hash> in <duration> at <time>");
    expect(normalizeLine("2026-10-22T11:11:11.0000000Z Deployed 0a1b2c3d4e in 3s at 11:11:14")).toBe("Deployed <hash> in <duration> at <time>");
    expect(normalizeLine("Process completed with exit code 2.")).not.toBe(normalizeLine("Process completed with exit code 1."));
    expect(normalizeLine("wrote /tmp/tmp.Xy12ab/out.json")).toBe("wrote /tmp/<tmp>/out.json");
  });

  it("finds the new error lines between a passing and a failing log, without timestamp noise", () => {
    const passing = store([
      "2026-10-20T09:00:00.0Z ##[group]Run npm test",
      "2026-10-20T09:00:00.1Z ##[endgroup]",
      "2026-10-20T09:00:01.0Z running 12 tests",
      "2026-10-20T09:00:09.0Z 12 passing (8s)",
    ]);
    const failing = store(LOG);
    const a = fingerprints(passing, true);
    // Essential: the step header stays, the control marker is left out.
    expect([...a.lines]).toEqual([0, 2, 3]);
    const { diff, own } = diffAgainst(a.hashes, failing, true, undefined, 1000);
    if ("tooLarge" in diff) throw new Error("unexpected");
    const added = diff.ops.filter((o) => o.kind === "add").flatMap((o) => Array.from({ length: o.length }, (_, i) => own.lines[o.b + i]!));
    expect(added).toEqual([3, 4, 5, 6]);
    expect(diff.ops.filter((o) => o.kind === "remove").map((o) => a.lines[o.a])).toEqual([3]);
    // The shared lines matched despite different timestamps.
    expect(diff.ops[0]).toMatchObject({ kind: "equal", length: 2 });
  });

  it("compares a range of lines (one step) only", () => {
    const s = store(["a", "b", "c", "d"]);
    expect([...fingerprints(s, false, [1, 3]).lines]).toEqual([1, 2]);
    expect(hashText("same")).toBe(hashText("same"));
  });
});

describe("failure evidence in a large log", () => {
  it("keeps an annotation in the middle of a log that has more weak matches than the evidence cap", () => {
    const lines = [...Array(21_000).fill("error: retrying the flaky mirror"), "##[error]Deployment target rejected the release", ...Array(5_000).fill("error: retrying")];
    const s = store(lines);
    const m = s.markers();
    expect(m.evidence?.some((e) => e.line === 21_000 && e.rank === 0)).toBe(true);
    // Still in log order, and still capped.
    const evidence = m.evidence!;
    expect(evidence.every((e, i) => i === 0 || evidence[i - 1]!.line < e.line)).toBe(true);
    expect(evidence.length).toBeLessThanOrEqual(20_000);
  });
});
