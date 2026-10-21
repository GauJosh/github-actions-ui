import { Fragment, useEffect, useRef, useState } from "react";
import type { Matcher, Tiers, ViewRow } from "../domain/logs/view";
import type { NodeStatus } from "../domain/graph/build";
import { count as fmt } from "./copy";
import { StatusIcon, STATUS_LABEL } from "./status";

const ROW = 20;
/** Step heading rows are taller; the worker reports where they are, so row positions stay computable. */
const STEP_ROW = 30;
const EXTRA = STEP_ROW - ROW;
const HEIGHT = 520;
const OVERSCAN = 20;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;

type LineRow = Extract<ViewRow, { t: "line" }>;

/** Badges for lines of error and warning evidence. The tier shows in the badge's style; the reason on hover. */
function badgeFor(row: LineRow): { text: string; cls: string; title: string } | undefined {
  switch (row.kind) {
    case "error":
      return { text: row.reason.includes("exit code") ? "exit code" : "error", cls: "annotation", title: `Runner error annotation (##[error]). ${row.reason.includes("exit code") ? "It only reports the exit code; the cause is usually in the lines above." : ""}` };
    case "warning":
      return { text: "warning", cls: "annotation-warning", title: "Runner warning annotation (##[warning])" };
    case "notice":
      return { text: "notice", cls: "notice", title: "Runner notice annotation (##[notice])" };
    case "error-signature":
      return { text: SIGNATURE_BADGE.find(([k]) => row.reason.includes(k))?.[1] ?? "failure", cls: "signature", title: `Strong failure signature: ${row.reason.replace(/^failure signature: /, "")}. Tools print this when something fails; GitHub's step result says whether the step failed.` };
    case "test-failed":
      return { text: "test failure", cls: "signature", title: "A test or build tool's failure report. GitHub's step result says whether the step failed." };
    case "error-text":
      return { text: "error?", cls: "text", title: "Text that only starts like an error message. A text match does not show that a command or the job failed." };
    case "warning-text":
      return { text: "warning?", cls: "text", title: "Text that looks like a warning. A text match is not a runner annotation." };
    default:
      return undefined;
  }
}
const SIGNATURE_BADGE: [string, string][] = [
  ["error code", "error code"],
  ["traceback", "exception"],
  ["Java", "exception"],
  ["exception", "exception"],
  ["stack trace", "exception"],
  ["panic", "panic"],
  ["compiler", "compiler"],
  ["command not found", "not found"],
  ["make", "make"],
  ["npm", "npm error"],
  ["fatal", "fatal"],
];

/** What the log view needs to know about a step to draw its heading. */
export type StepHeading = { name: string; status: NodeStatus; duration: string; approximate: boolean; selected: boolean };

type Props = {
  rowCount: number;
  /** View version; rows are fetched again when it changes. */
  version: number;
  fetchRows(version: number, from: number, count: number): Promise<ViewRow[]>;
  /** Indexes of step heading rows, ascending. */
  stepRows?: number[];
  /** Row to scroll to whenever `scrollKey` changes. */
  scrollToRow?: number;
  scrollKey?: string;
  /** 1-based line to highlight. */
  highlight?: number;
  /** 1-based inclusive lines of the selected step, shaded; `marks` are its error lines. */
  range?: { start: number; end: number; marks: number[] };
  matcher?: Matcher | null;
  hrefFor(line: number): string;
  /** Shows the original lines of a fold (0-based, inclusive). */
  onExpand(start: number, end: number): void;
  step?(number: number): StepHeading | undefined;
  onToggleStep?(number: number, collapsed: boolean): void;
};

/** Number of entries in the ascending list that are below `r`. */
function below(list: number[], r: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Renders only the visible rows of a worker-built view. Line numbers shown are the original, 1-based ones. */
export function VirtualLog({ rowCount, version, fetchRows, stepRows = [], scrollToRow, scrollKey, highlight, range, matcher, hrefFor, onExpand, step, onToggleStep }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [rows, setRows] = useState<{ from: number; rows: ViewRow[] }>({ from: 0, rows: [] });
  const top = (r: number) => r * ROW + below(stepRows, r) * EXTRA;
  // The first row whose top is at or above the scroll position.
  let at = 0;
  for (let lo = 0, hi = Math.max(0, rowCount - 1); lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    if (top(mid) <= scrollTop) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const first = Math.max(0, at - OVERSCAN);
  const span = Math.ceil(HEIGHT / ROW) + OVERSCAN * 2;

  useEffect(() => {
    let current = true;
    void fetchRows(version, first, span).then((fetched) => {
      if (current && (fetched.length > 0 || first >= rowCount)) setRows({ from: first, rows: fetched });
    });
    return () => {
      current = false;
    };
  }, [first, span, version, rowCount, fetchRows]);

  // Scroll once per key, as soon as a row for it is known; later rebuilds (more lines loaded) leave the scroll alone.
  const scrolled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (scrollToRow === undefined || scrollToRow < 0 || !scroller.current || scrolled.current === scrollKey) return;
    scrolled.current = scrollKey;
    scroller.current.scrollTop = Math.max(0, top(scrollToRow) - HEIGHT / 3);
    // The line may arrive after the page was scrolled elsewhere (e.g. to a Load or Resume button).
    scroller.current.scrollIntoView({ block: "nearest" });
  });

  return (
    <div className="log-scroll" ref={scroller} style={{ height: HEIGHT }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="log-view">
      <div style={{ height: rowCount * ROW + stepRows.length * EXTRA, position: "relative" }}>
        {rows.rows.map((row, i) => {
          const r = rows.from + i;
          if (r >= rowCount) return null;
          if (row.t === "step") return <StepRow key={`s${row.number}`} row={row} top={top(r)} info={step?.(row.number)} onToggle={onToggleStep} hrefFor={hrefFor} />;
          if (row.t === "fold") {
            const lines = row.end - row.start + 1;
            const noun = `${fmt(lines)} ${lines === 1 ? "line" : "lines"}`;
            const text = row.kind === "gap" ? `${noun} not shown` : row.kind === "outside" ? `${noun} outside the selected step` : `${noun} folded${row.label ? ` · ${row.label}` : ""}`;
            return (
              <div key={`f${row.start}`} className={`row fold fold-${row.kind}`} style={{ top: top(r) }} data-testid="log-fold" data-start={row.start + 1} data-end={row.end + 1}>
                <span className="ln" />
                <button type="button" className="fold-btn" onClick={() => onExpand(row.start, row.end)} title={`Show lines ${row.start + 1}–${row.end + 1}`}>
                  ▸ {text} <span className="fold-range">(lines {row.start + 1}–{row.end + 1})</span>
                </button>
              </div>
            );
          }
          const n = row.n + 1;
          const inStep = range !== undefined && n >= range.start && n <= range.end;
          const cls = ["row", `k-${row.kind}`, inStep && "in-step", inStep && n === range.start && "step-start", inStep && range.marks.includes(n) && "step-error", n === highlight && "highlighted"].filter(Boolean).join(" ");
          const badge = badgeFor(row);
          return (
            <div key={n} className={cls} style={{ top: top(r) }} data-line={n} data-kind={row.kind} title={`${row.kind}: ${row.reason}`}>
              <a className="ln" href={hrefFor(n)}>
                {n}
              </a>
              <span className="tx">
                {badge && (
                  <span className={`kbadge kbadge-${badge.cls}`} title={badge.title} data-badge={badge.cls}>
                    {badge.text}
                  </span>
                )}
                <LineText text={row.text} matcher={matcher} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type StepViewRow = Extract<ViewRow, { t: "step" }>;

function evidenceText(t: Tiers): string[] {
  const out: string[] = [];
  if (t.annotations) out.push(`${fmt(t.annotations)} error annotation${t.annotations === 1 ? "" : "s"}`);
  if (t.signatures) out.push(`${fmt(t.signatures)} failure signature${t.signatures === 1 ? "" : "s"}`);
  if (t.text) out.push(`${fmt(t.text)} error-like line${t.text === 1 ? "" : "s"}`);
  if (t.warnings) out.push(`${fmt(t.warnings)} warning${t.warnings === 1 ? "" : "s"}`);
  return out;
}

/** A step's heading: status, name, duration, its lines, its error evidence, and a toggle for its output. */
function StepRow({ row, top, info, onToggle, hrefFor }: { row: StepViewRow; top: number; info?: StepHeading; onToggle?(n: number, collapsed: boolean): void; hrefFor(line: number): string }) {
  const lines = row.end - row.start + 1;
  const status = info?.status ?? "unknown";
  const evidence = evidenceText(row.tiers);
  return (
    <div
      className={`row step-row s-${status}${row.collapsed ? " collapsed" : ""}${info?.selected ? " selected" : ""}`}
      style={{ top, height: STEP_ROW }}
      data-testid="log-step"
      data-step={row.number}
      data-collapsed={row.collapsed}
      data-status={status}
    >
      <button type="button" className="step-toggle" aria-expanded={!row.collapsed} onClick={() => onToggle?.(row.number, !row.collapsed)} title={row.collapsed ? "Show this step's output" : "Collapse this step"}>
        <span aria-hidden="true">{row.collapsed ? "▸" : "▾"}</span>
        <StatusIcon status={status} />
        <span className="visually-hidden">{STATUS_LABEL[status]}:</span>
        <span className="step-name">
          Step {row.number}
          {info ? ` · ${info.name}` : ""}
        </span>
      </button>
      {info?.duration && <span className="step-meta">{info.duration}</span>}
      <a className="step-meta" href={hrefFor(row.start + 1)} title={info?.approximate ? "Step boundaries are approximate" : "From the runner's step markers"}>
        {info?.approximate ? "≈ " : ""}lines {fmt(row.start + 1)}–{fmt(row.end + 1)}
      </a>
      {evidence.length > 0 && <span className="step-evidence">{evidence.join(" · ")}</span>}
      {row.collapsed ? (
        row.preview && (
          <span className="step-preview" title={`Line ${row.preview.n + 1}`}>
            {row.preview.text.replace(STAMP, "")}
          </span>
        )
      ) : (
        <span className="step-meta">
          {fmt(row.shown)} of {fmt(lines)} lines shown
        </span>
      )}
    </div>
  );
}

/** The line with its timestamp muted and search matches marked. The text itself is shown unchanged. */
function LineText({ text, matcher }: { text: string; matcher?: Matcher | null }) {
  const stamp = STAMP.exec(text)?.[0].length ?? 0;
  const marks = matcher ? matcher.ranges(text) : [];
  if (marks.length === 0) {
    return stamp ? (
      <>
        <span className="ts">{text.slice(0, stamp)}</span>
        {text.slice(stamp)}
      </>
    ) : (
      <>{text}</>
    );
  }
  const cuts = [...new Set([0, stamp, ...marks.flat(), text.length])].filter((x) => x <= text.length).sort((a, b) => a - b);
  return (
    <>
      {cuts.slice(0, -1).map((from, i) => {
        const to = cuts[i + 1]!;
        if (to <= from) return null;
        const part = text.slice(from, to);
        const marked = marks.some(([a, b]) => from >= a && to <= b);
        const inStamp = to <= stamp;
        const content = inStamp ? <span className="ts">{part}</span> : part;
        return <Fragment key={from}>{marked ? <mark>{content}</mark> : content}</Fragment>;
      })}
    </>
  );
}
