import { Fragment, useEffect, useRef, useState } from "react";
import type { Matcher, ViewRow } from "../domain/logs/view";
import { count as fmt } from "./copy";

const ROW = 20;
const HEIGHT = 520;
const OVERSCAN = 20;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;

/** Badges for lines that report a problem: runner annotations versus text that only looks like one. */
const BADGES: Partial<Record<ViewRow["kind"], { text: string; title: string }>> = {
  error: { text: "error", title: "Runner error annotation (##[error])" },
  warning: { text: "warning", title: "Runner warning annotation (##[warning])" },
  notice: { text: "notice", title: "Runner notice annotation (##[notice])" },
  "error-text": { text: "error?", title: "Text that looks like an error. A text match does not show that a command or the job failed." },
  "warning-text": { text: "warning?", title: "Text that looks like a warning. A text match is not a runner annotation." },
  "test-failed": { text: "test fail?", title: "Text that looks like a test or build failure report. A text match does not show that the job failed." },
};

type Props = {
  rowCount: number;
  /** View version; rows are fetched again when it changes. */
  version: number;
  fetchRows(version: number, from: number, count: number): Promise<ViewRow[]>;
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
};

/** Renders only the visible rows of a worker-built view. Line numbers shown are the original, 1-based ones. */
export function VirtualLog({ rowCount, version, fetchRows, scrollToRow, scrollKey, highlight, range, matcher, hrefFor, onExpand }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [rows, setRows] = useState<{ from: number; rows: ViewRow[] }>({ from: 0, rows: [] });
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
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
    scroller.current.scrollTop = Math.max(0, scrollToRow * ROW - HEIGHT / 3);
    // The line may arrive after the page was scrolled elsewhere (e.g. to a Load or Resume button).
    scroller.current.scrollIntoView({ block: "nearest" });
  }, [scrollKey, scrollToRow]);

  return (
    <div className="log-scroll" ref={scroller} style={{ height: HEIGHT }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="log-view">
      <div style={{ height: rowCount * ROW, position: "relative" }}>
        {rows.rows.map((row, i) => {
          const r = rows.from + i;
          if (r >= rowCount) return null;
          if (row.t === "fold") {
            const lines = row.end - row.start + 1;
            const text = row.kind === "gap" ? `${fmt(lines)} ${lines === 1 ? "line" : "lines"} not shown` : `${fmt(lines)} ${lines === 1 ? "line" : "lines"} folded${row.label ? ` · ${row.label}` : ""}`;
            return (
              <div key={`f${row.start}`} className={`row fold fold-${row.kind}`} style={{ top: r * ROW }} data-testid="log-fold" data-start={row.start + 1} data-end={row.end + 1}>
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
          const badge = BADGES[row.kind];
          return (
            <div key={n} className={cls} style={{ top: r * ROW }} data-line={n} data-kind={row.kind} title={`${row.kind}: ${row.reason}`}>
              <a className="ln" href={hrefFor(n)}>
                {n}
              </a>
              <span className="tx">
                {badge && (
                  <span className={`kbadge kbadge-${row.kind}`} title={badge.title}>
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
