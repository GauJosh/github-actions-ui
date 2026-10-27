// Adds a range of lines from the open log to the investigation report, only when the user asks. The lines are read
// from the log the worker already holds (no request); a range over the report's limits is refused, never cut, and
// lines too long for the report are named before anything is added. One job, and at most one step, per excerpt.
//
// The range is held by the log panel, so its boundaries can be typed here or set from a log row's line menu
// ("Set as first line", "Set as last line"); both go through the same checks below.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { checkExcerpt, checkExcerptSize, REPORT_LIMITS, type ExcerptInput } from "../domain/report/report";
import type { StepMapping } from "../domain/steps/step-map";
import type { Job } from "../domain/types";
import type { LogLoader } from "../logs/download/loader";
import { count } from "./copy";

/** The report's excerpts for the run and attempt on screen. */
export type ReportExcerpts = { held: number; add(excerpt: ExcerptInput): void };

/** The first and last line as entered (text, so a field can be empty while typed). */
export type ExcerptRange = { from: string; to: string };

/** The range as line numbers, or why it is not one. Boundaries are never swapped. */
export function parseRange(range: ExcerptRange): { start: number; end: number } | { problem: string } {
  const start = Number(range.from);
  const end = Number(range.to);
  if (range.from.trim() === "" || range.to.trim() === "" || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1)
    return { problem: "Enter a first and a last line number." };
  if (start > end) return { problem: `The first line (${count(start)}) is after the last line (${count(end)}). Change one of them; they are not swapped.` };
  return { start, end };
}

type Props = {
  loader: LogLoader;
  job: Job;
  /** Lines of the full log loaded so far, and whether all of it is. */
  loaded: number;
  complete: boolean;
  mapping?: StepMapping;
  range: ExcerptRange;
  onRange(range: ExcerptRange): void;
  report: ReportExcerpts;
};

type Pending = { excerpt: ExcerptInput; longLines: number[]; range: string };

export function ExcerptPicker({ loader, job, loaded, complete, mapping, range, onRange, report }: Props) {
  const [problem, setProblem] = useState<{ text: string; range: string }>();
  const [pending, setPending] = useState<Pending>();
  const [added, setAdded] = useState<{ text: string; range: string }>();
  // A read that finishes after the log closed (another job, attempt or run) adds nothing.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Messages about one range are not shown for another.
  const rangeKey = `${range.from}-${range.to}`;
  const parsed = parseRange(range);

  const add = (excerpt: ExcerptInput) => {
    report.add(excerpt);
    setPending(undefined);
    setAdded({ text: `Lines ${count(excerpt.startLine)}–${count(excerpt.startLine + excerpt.lines.length - 1)} added to the report.`, range: rangeKey });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(undefined);
    setPending(undefined);
    setAdded(undefined);
    const fail = (text: string) => setProblem({ text, range: rangeKey });
    if ("problem" in parsed) return fail(parsed.problem);
    const { start, end } = parsed;
    if (end > loaded) return fail(`Line ${count(end)} is not loaded; the log has ${count(loaded)} lines loaded.`);
    // Checked before reading, so an oversized range is never read or cut.
    const size = checkExcerptSize(end - start + 1, report.held);
    if (size) return fail(size);
    // One step per excerpt: a range across step boundaries is refused.
    const segments = mapping?.segments ?? [];
    const within = segments.find((s) => start >= s.startLine && end <= s.endLine);
    if (!within && segments.some((s) => start <= s.endLine && end >= s.startLine)) return fail("The range crosses a step boundary. Select lines within one step (an excerpt belongs to one step).");
    const lines = await loader.rows("full", start - 1, end - start + 1);
    if (!live.current) return;
    if (lines.length !== end - start + 1) return fail("Those lines could not be read from the loaded log.");
    const check = checkExcerpt(lines, report.held);
    if (check.error) return fail(check.error);
    const excerpt: ExcerptInput = { jobId: job.id, ...(within && { stepNumber: within.stepNumber }), startLine: start, lines };
    if (check.longLines.length) setPending({ excerpt, longLines: check.longLines, range: rangeKey });
    else add(excerpt);
  }

  if (!complete)
    return (
      <p className="note excerpt-picker" data-testid="excerpt-picker" data-state="unavailable">
        Lines can be added to the investigation report once the full log has loaded (line numbers and steps need all of it).
      </p>
    );
  const shownProblem = problem?.range === rangeKey ? problem.text : undefined;
  const shownPending = pending?.range === rangeKey ? pending : undefined;
  return (
    <form className="excerpt-picker" onSubmit={(e) => void submit(e)} data-testid="excerpt-picker" aria-label="Add log lines to the investigation report">
      <span className="excerpt-picker-title">Add lines to the report</span>
      <label>
        From line <input type="number" min={1} max={loaded} value={range.from} onChange={(e) => onRange({ ...range, from: e.target.value })} data-testid="excerpt-from" />
      </label>
      <label>
        to line <input type="number" min={1} max={loaded} value={range.to} onChange={(e) => onRange({ ...range, to: e.target.value })} data-testid="excerpt-to" />
      </label>
      <button type="submit" disabled={"problem" in parsed} data-testid="add-excerpt">
        Add to report
      </button>
      <p className="excerpt-range" role="status" data-testid="excerpt-range" data-state={"problem" in parsed ? "invalid" : "valid"}>
        {"problem" in parsed ? parsed.problem : `Selected: lines ${count(parsed.start)}–${count(parsed.end)} (${count(parsed.end - parsed.start + 1)} line${parsed.end === parsed.start ? "" : "s"}), shaded in the log.`}
      </p>
      <span className="muted">
        Set either boundary here or from a line number&apos;s ⋮ menu in the log. Up to {REPORT_LIMITS.linesPerExcerpt} lines within one step; {report.held} of {REPORT_LIMITS.excerpts} excerpts held. They are
        kept while this run and attempt are on screen, and discarded when either changes.
      </span>
      {shownProblem && (
        <p className="state state-error" role="alert" data-testid="excerpt-problem">
          {shownProblem}
        </p>
      )}
      {shownPending && (
        <div className="state" role="alert" data-testid="excerpt-long-lines">
          <p>
            {shownPending.longLines.length === 1 ? "Line" : "Lines"} {shownPending.longLines.map((i) => count(shownPending.excerpt.startLine + i)).join(", ")}{" "}
            {shownPending.longLines.length === 1 ? "is" : "are"} longer than {count(REPORT_LIMITS.charsPerLine)} characters. The report keeps the first {count(REPORT_LIMITS.charsPerLine)} characters of each,
            followed by &ldquo;…&rdquo;, and marks the excerpt as shortened.
          </p>
          <button type="button" onClick={() => add(shownPending.excerpt)} data-testid="add-excerpt-cut">
            Add with those lines shortened
          </button>{" "}
          <button type="button" onClick={() => setPending(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {added?.range === rangeKey && (
        <p role="status" data-testid="excerpt-added">
          {added.text}
        </p>
      )}
    </form>
  );
}
