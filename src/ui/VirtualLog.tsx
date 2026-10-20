import { useEffect, useRef, useState } from "react";

const ROW = 20;
const HEIGHT = 520;
const OVERSCAN = 20;
const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z )(.*)$/;

type Props = {
  lineCount: number;
  fetchRows(from: number, count: number): Promise<string[]>;
  /** 1-based line to highlight and scroll to. */
  highlight?: number;
  hrefFor(line: number): string;
};

/** Renders only the visible rows of a worker-owned log. Line numbers shown are 1-based. */
export function VirtualLog({ lineCount, fetchRows, highlight, hrefFor }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [rows, setRows] = useState<{ from: number; lines: string[] }>({ from: 0, lines: [] });
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const span = Math.ceil(HEIGHT / ROW) + OVERSCAN * 2;
  const highlightReady = highlight !== undefined && highlight <= lineCount;

  useEffect(() => {
    let current = true;
    void fetchRows(first, span).then((lines) => {
      if (current) setRows({ from: first, lines });
    });
    return () => {
      current = false;
    };
  }, [first, span, lineCount, fetchRows]);

  useEffect(() => {
    if (highlightReady && scroller.current) scroller.current.scrollTop = Math.max(0, (highlight - 1) * ROW - HEIGHT / 3);
  }, [highlight, highlightReady]);

  return (
    <div className="log-scroll" ref={scroller} style={{ height: HEIGHT }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="log-view">
      <div style={{ height: lineCount * ROW, position: "relative" }}>
        {rows.lines.map((text, i) => {
          const n = rows.from + i + 1;
          const m = STAMP.exec(text);
          return (
            <div key={n} className={n === highlight ? "row highlighted" : "row"} style={{ top: (n - 1) * ROW }} data-line={n}>
              <a className="ln" href={hrefFor(n)}>
                {n}
              </a>
              <span className="tx">
                {m ? (
                  <>
                    <span className="ts">{m[1]}</span>
                    {m[2]}
                  </>
                ) : (
                  text
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
