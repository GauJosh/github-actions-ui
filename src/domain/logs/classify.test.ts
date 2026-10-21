import { describe, expect, it } from "vitest";
import { FOLD, classifyLines, kindOf, reasonOf } from "./classify";
import { SAMPLE } from "../../../tools/fixture-server/noisy-log";
import { LogView, compileSearch, foldLabel, type ViewSource, type ViewSpec } from "./view";

const ESC = String.fromCharCode(27);
const cyan = (t: string) => `${ESC}[36;1m${t}${ESC}[0m`;

function source(lines: string[]): ViewSource {
  const classified = classifyLines(lines);
  return { lineCount: lines.length, completeLines: lines.length, classified, text: (n) => lines[n]!.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "") };
}
const spec = (s: Partial<ViewSpec> = {}): ViewSpec => ({ mode: "essential", filters: [], context: 0, expanded: [], reveal: [], ...s });
function shownLines(src: ViewSource, s: ViewSpec): number[] {
  const view = new LogView();
  const summary = view.build(src, s);
  return view
    .rowsAt(0, summary.rowCount)
    .filter((r) => r.t === "line")
    .map((r) => (r as { n: number }).n);
}

describe("line classification", () => {
  const c = classifyLines(SAMPLE);
  const kind = (n: number) => kindOf(c.kinds[n]!);

  it("recognises runner markers, setup and cleanup messages, and step headers", () => {
    expect([0, 8, 9, 10, 11, 12, 13].map(kind)).toEqual(Array(7).fill("runner"));
    expect([4, 7, 18, 24, 30, 43].map(kind)).toEqual(Array(6).fill("control"));
    expect([14, 25, 37].map(kind)).toEqual(["command", "command", "command"]);
    expect(kind(1)).toBe("section");
    expect([2, 3, 6].map(kind)).toEqual(["runner", "runner", "runner"]); // inside setup groups
    expect(kind(53)).toBe("runner");
    expect(kind(55)).toBe("runner");
  });

  it("recognises the runner's echo of a step: script, shell, inputs and environment", () => {
    expect([38, 39].map(kind)).toEqual(["script", "script"]);
    expect([15, 16, 17, 26, 27, 28, 29, 40, 41, 42].map(kind)).toEqual(Array(10).fill("settings"));
  });

  it("separates explicit annotations from text that merely looks like an error or warning", () => {
    expect(kind(52)).toBe("error");
    expect(reasonOf(c.reasons[52]!)).toBe("runner annotation ##[error]");
    expect(kind(51)).toBe("warning");
    expect(kind(48)).toBe("error-text");
    expect(reasonOf(c.reasons[48]!)).toMatch(/^text pattern/);
    expect(kind(50)).toBe("warning-text");
    // Familiar words alone are not enough.
    expect(kind(49)).toBe("output");
  });

  it("recognises test results, and output of actions versus run: steps", () => {
    expect(kind(45)).toBe("test");
    expect(kind(46)).toBe("test-failed");
    expect(kind(47)).toBe("test-failed");
    expect(kind(31)).toBe("action-output"); // custom action output: visible, labelled
    expect(kind(44)).toBe("output");
    expect(kind(22)).toBe("command");
    expect(kind(54)).toBe("command");
    expect(kind(56)).toBe("output");
  });

  it("folds only closed groups, step definitions, exact lifecycle messages, control markers and repeats", () => {
    const fold = (n: number) => c.folds[n];
    expect([1, 2, 3, 5, 6, 21, 22, 23].map(fold)).toEqual(Array(8).fill(FOLD.group));
    expect(fold(20)).toBe(FOLD.none); // a group inside a step keeps its header visible
    expect([15, 16, 17, 26, 29, 38, 39, 40, 42].map(fold)).toEqual(Array(9).fill(FOLD.definition));
    expect([0, 8, 13].map(fold)).toEqual(Array(3).fill(FOLD.setup));
    expect(fold(55)).toBe(FOLD.cleanup);
    expect([33, 34, 35].map(fold)).toEqual(Array(3).fill(FOLD.repeat));
    // Never folded: the first of the repeats, step headers, action output, results, annotations, unknown lines.
    for (const n of [14, 19, 20, 25, 31, 32, 36, 37, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 56]) expect(fold(n), `line ${n}`).toBe(FOLD.none);
    expect(c.groups.map((g) => g.name)).toEqual(["Runner Image Provisioner", "GITHUB_TOKEN Permissions", "Run actions/checkout@v4", "Getting Git version info", "Run ./.github/actions/deploy-config", "Run npm test"]);
  });

  it("keeps a group open when it holds an error, and does not fold an unclosed or malformed group", () => {
    const lines = ["##[group]Fetching", "fetching…", "##[error]fetch failed", "##[endgroup]", "##[group]Unclosed", "body line", "##[group]Next", "x", "##[endgroup]", "##[endgroup]"];
    const k = classifyLines(lines);
    expect([0, 1, 2].map((n) => k.folds[n])).toEqual([0, 0, 0]);
    expect([4, 5].map((n) => k.folds[n])).toEqual([0, 0]);
    expect([6, 7].map((n) => k.folds[n])).toEqual([FOLD.group, FOLD.group]); // a job-setup group folds whole
    expect(k.malformed).toBe(2); // the unclosed group and the unmatched end marker
  });

  it("handles lines without timestamps, CRLF endings and a byte-order mark", () => {
    const k = classifyLines(["﻿Current runner version: '2.337.0'\r", "##[group]Run make\r", "##[endgroup]\r", "plain output\r"]);
    expect([0, 1, 2, 3].map((n) => kindOf(k.kinds[n]!))).toEqual(["runner", "command", "control", "output"]);
  });

  it("does not fold a step's echo when the group holds other output (malformed echo)", () => {
    const k = classifyLines(["##[group]Run make", cyan("make"), "make: building", "##[endgroup]"]);
    expect(kindOf(k.kinds[2]!)).toBe("output");
    expect(k.folds[1]).toBe(FOLD.definition);
    expect(k.folds[2]).toBe(FOLD.none);
  });
});

describe("display views", () => {
  const src = source(SAMPLE);

  it("Essential output folds noise into labelled rows and keeps everything else, with original line numbers", () => {
    const view = new LogView();
    const summary = view.build(src, spec());
    const rows = view.rowsAt(0, summary.rowCount);
    const lines = rows.filter((r) => r.t === "line").map((r) => (r as { n: number }).n);
    expect(lines).toEqual([14, 19, 20, 25, 31, 32, 36, 37, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 56]);
    const folds = rows.filter((r) => r.t === "fold") as { start: number; end: number; label: string }[];
    expect(folds[0]).toMatchObject({ start: 0, end: 13 });
    expect(folds[0]!.label).toBe("runner setup · 2 groups: “Runner Image Provisioner”, “GITHUB_TOKEN Permissions”");
    expect(folds.find((f) => f.start === 33)!.label).toBe("repeated identical lines");
    expect(folds.find((f) => f.start === 38)!.label).toBe("step script and settings echoed by the runner");
    // Every original line is either shown or inside exactly one fold.
    const covered = new Set(lines);
    for (const f of folds) for (let n = f.start; n <= f.end; n++) covered.add(n);
    expect(covered.size).toBe(SAMPLE.length);
    expect(summary.visibleLines + folds.reduce((s, f) => s + f.end - f.start + 1, 0)).toBe(SAMPLE.length);
  });

  it("All output shows every line; expanding a fold restores exactly its original lines", () => {
    expect(shownLines(src, spec({ mode: "all" }))).toEqual(SAMPLE.map((_, i) => i));
    const expanded = shownLines(src, spec({ expanded: [[0, 13]] }));
    expect(expanded.slice(0, 15)).toEqual([...Array(15).keys()]);
    const view = new LogView();
    view.build(src, spec({ expanded: [[0, 13]] }));
    const row = view.rowsAt(0, 1)[0]!;
    expect(row).toMatchObject({ t: "line", n: 0, text: SAMPLE[0] });
  });

  it("Errors and warnings shows annotations and text matches with context and the step header, nothing else", () => {
    expect(shownLines(src, spec({ mode: "problems" }))).toEqual([37, 46, 47, 48, 50, 51, 52]);
    expect(shownLines(src, spec({ mode: "problems", context: 1 }))).toEqual([37, 45, 46, 47, 48, 49, 50, 51, 52, 53]);
  });

  it("quick filters combine, with counts", () => {
    const view = new LogView();
    const summary = view.build(src, spec({ filters: ["commands", "tests"] }));
    expect(summary.counts).toMatchObject({ errors: 4, warnings: 2, commands: 7, tests: 3, actions: 9, settings: 10, unclassified: 3 });
    expect(shownLines(src, spec({ filters: ["commands", "tests"] }))).toEqual([14, 22, 25, 37, 38, 39, 45, 46, 47, 54]);
    expect(shownLines(src, spec({ filters: ["unclassified"] }))).toEqual([44, 49, 56]);
  });

  it("reveals a target line inside a fold and reports its row", () => {
    const view = new LogView();
    const summary = view.build(src, spec({ reveal: [16] }));
    const r = summary.revealRows[0]!;
    expect(view.rowsAt(r, 1)[0]).toMatchObject({ t: "line", n: 16 });
    expect(view.rowOf(2)).toBe(0); // inside the first fold
  });
});

describe("search", () => {
  const src = source(SAMPLE);
  const run = (query: string, o: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean; only: boolean; scope: [number, number] }> = {}) => {
    const view = new LogView();
    return view.build(src, spec({ search: { query, caseSensitive: false, wholeWord: false, regex: false, only: false, ...o } }));
  };

  it("supports case sensitivity, whole words and regular expressions, with safe handling of invalid ones", () => {
    expect(run("error").matches).toEqual([48, 49, 52]);
    expect(run("Error", { caseSensitive: true }).matches).toEqual([48]);
    expect(run("error", { wholeWord: true }).matches).toEqual([48, 49, 52]);
    expect(run("errors", { wholeWord: true }).matches).toEqual([49]);
    expect(run("err", { wholeWord: true }).matches).toEqual([]);
    expect(run("^.{29}(PASS|FAIL) ", { regex: true }).matches).toEqual([45, 46]);
    const bad = run("(unclosed", { regex: true });
    expect(bad.searchError).toBeDefined();
    expect(bad.matches).toEqual([]);
    expect(compileSearch({ query: "", caseSensitive: false, wholeWord: false, regex: false })).toBeNull();
  });

  it("searches within a step's lines, and can show only matching lines with context", () => {
    expect(run("git", { scope: [14, 24] }).matches).toEqual([20, 22, 23]);
    expect(shownLines(src, spec({ context: 1, search: { query: "503", caseSensitive: false, wholeWord: false, regex: false, only: true } }))).toEqual([47, 48, 49]);
  });

  it("highlights match ranges", () => {
    const m = compileSearch({ query: "ab", caseSensitive: false, wholeWord: false, regex: false })!;
    expect("ranges" in m && m.ranges("xABxab")).toEqual([
      [1, 3],
      [4, 6],
    ]);
  });
});

describe("partial logs", () => {
  it("views and searches the lines loaded so far; the growing last line is shown unclassified and not cached", () => {
    const lines = SAMPLE.slice(0, 30);
    const c = classifyLines(lines.slice(0, 29));
    const src: ViewSource = { lineCount: 30, completeLines: 29, classified: c, text: (n) => lines[n]! };
    const view = new LogView();
    const s1 = view.build(src, spec({ search: { query: "REGION", caseSensitive: true, wholeWord: false, regex: false, only: false } }));
    expect(s1.matches).toEqual([29]);
    const last = view.rowsAt(s1.rowCount - 1, 1)[0]!;
    expect(last).toMatchObject({ t: "line", n: 29, reason: "not classified yet (line still loading)" });
    // The group around the inputs is not closed yet, so nothing in it is folded.
    expect(shownLines(src, spec())).toContain(26);
  });

  it("labels a fold of filtered-out lines as a gap", () => {
    const src = source(SAMPLE);
    const view = new LogView();
    const s = view.build(src, spec({ filters: ["errors"] }));
    const gap = view.rowsAt(0, s.rowCount).find((r) => r.t === "fold")!;
    expect(gap).toMatchObject({ kind: "gap", label: "" });
    expect(foldLabel(src.classified, 53, 55)).toBe("runner cleanup");
  });
});

describe("large logs", () => {
  it("handles many collapsed sections quickly and reversibly", () => {
    const lines: string[] = [];
    for (let s = 0; s < 5000; s++) lines.push(`##[group]Section ${s}`, "a", "b", "##[endgroup]", `result ${s}`);
    const src = source(lines);
    const view = new LogView();
    const t0 = Date.now();
    const summary = view.build(src, spec());
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(summary.visibleLines).toBe(5000);
    expect(summary.folds).toBe(5000);
    expect(summary.rowCount).toBe(10000);
    const all = view.build(src, spec({ mode: "all" }));
    expect(all.rowCount).toBe(lines.length);
  });
});
