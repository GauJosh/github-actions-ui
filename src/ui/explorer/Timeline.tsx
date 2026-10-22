// Execution timeline (Gantt): when each job ran, on one time axis. Complements the dependency graph: the timeline
// answers "when did things run?", the graph "what depends on what?". Model: src/domain/insights/timeline.ts.
// Rows are windowed, so large runs render only what is on screen.
import { useMemo, useRef, useState } from "react";
import { ticks, type Timeline as Model, type TimelineRow } from "../../domain/insights/timeline";
import type { Job } from "../../domain/types";
import { formatDuration } from "../format";
import { STATUS_LABEL, StatusIcon } from "../status";

const ROW_H = 28;
const MAX_H = 560;
const OVERSCAN = 10;

type Item = { kind: "group"; id: string; label: string; count: number } | { kind: "row"; row: TimelineRow };

const NO_BAR: Record<Exclude<TimelineRow["timing"], "complete" | "running">, string> = {
  skipped: "skipped: did not run",
  "not-started": "not started yet",
  missing: "no timestamps from GitHub",
};

type Props = { model: Model; selectedJobId?: number; onSelectJob(job: Job): void };

export function Timeline({ model, selectedJobId, onSelectJob }: Props) {
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const items: Item[] = useMemo(() => model.groups.flatMap((g): Item[] => [{ kind: "group", id: g.id, label: g.label, count: g.rows.length }, ...g.rows.map((row): Item => ({ kind: "row", row }))]), [model]);
  const related = useMemo(() => {
    const needs = new Set<number>();
    const neededBy = new Set<number>();
    if (selectedJobId !== undefined)
      for (const e of model.edges) {
        if (e.to === selectedJobId) needs.add(e.from);
        if (e.from === selectedJobId) neededBy.add(e.to);
      }
    return { needs, neededBy };
  }, [model.edges, selectedJobId]);
  const selected = items.find((i): i is Extract<Item, { kind: "row" }> => i.kind === "row" && i.row.job.id === selectedJobId)?.row;

  if (model.origin === undefined) {
    return (
      <p className="state" data-testid="timeline-empty">
        No job of this run has started, so there is nothing to place on a time axis yet.
      </p>
    );
  }
  const pct = (ms: number) => `${(ms / model.span) * 100}%`;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((scrollTop + MAX_H) / ROW_H) + OVERSCAN);
  const counts = { noBar: items.filter((i) => i.kind === "row" && !["complete", "running"].includes(i.row.timing)).length };

  return (
    <div className="timeline" data-testid="timeline">
      <p className="note timeline-note">
        Bars run from each job's start to its completion, as GitHub reported them; queue time before a job started is drawn faintly and is not part of its
        duration. Running jobs have no end time yet and are drawn to the latest reported time.
        {model.grouping === "phases" ? " Grouped by the release overview's phases." : model.grouping === "calls" ? " Grouped by reusable-workflow call." : ""}
        {counts.noBar > 0 && ` ${counts.noBar} jobs have no bar (skipped, not started, or no timestamps).`} Select a job to see what it needs and what needs it.
      </p>
      <div className="tl-axis" aria-hidden="true">
        <span className="tl-label-col" />
        <span className="tl-track">
          {ticks(model.span).map((x) => (
            <span key={x} className="tl-tick" style={{ left: pct(x) }}>
              {formatDuration(x) || "0s"}
            </span>
          ))}
        </span>
      </div>
      <div className="tl-scroll" ref={scroller} style={{ height: Math.min(MAX_H, items.length * ROW_H + 2) }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="timeline-rows">
        <div style={{ height: items.length * ROW_H, position: "relative" }}>
          {selected?.start !== undefined && <span className="tl-marker" style={{ left: `calc(var(--tl-label) + (100% - var(--tl-label) - 70px) * ${selected.start / model.span})` }} aria-hidden="true" />}
          {items.slice(first, last).map((item, i) => {
            const top = (first + i) * ROW_H;
            if (item.kind === "group")
              return (
                <div key={`g:${item.id}`} className="tl-group" style={{ top }} data-testid="timeline-group">
                  {item.label} <span className="muted">· {item.count} jobs</span>
                </div>
              );
            const r = item.row;
            const id = r.job.id;
            const rel = related.needs.has(id) ? "needs" : related.neededBy.has(id) ? "needed-by" : "";
            const duration = r.start !== undefined && r.end !== undefined && r.timing === "complete" ? r.end - r.start : undefined;
            return (
              <div key={id} className={`tl-row${id === selectedJobId ? " selected" : ""}${rel ? ` rel-${rel}` : ""}`} style={{ top }} data-testid="timeline-row" data-job-id={id} data-timing={r.timing} data-status={r.status}>
                <button type="button" className="tl-label-col tl-name" onClick={() => onSelectJob(r.job)} aria-pressed={id === selectedJobId} title={r.job.name}>
                  <StatusIcon status={r.status} />
                  <span className="visually-hidden">{STATUS_LABEL[r.status]}:</span> {r.job.name}
                  {rel === "needs" && <span className="tl-rel"> · needed by selection</span>}
                  {rel === "needed-by" && <span className="tl-rel"> · needs selection</span>}
                </button>
                <span className="tl-track">
                  {r.start !== undefined && r.end !== undefined ? (
                    <>
                      {r.queuedFrom !== undefined && <span className="tl-queue" style={{ left: pct(r.queuedFrom), width: pct(r.start - r.queuedFrom) }} title={`Queued ${formatDuration(r.start - r.queuedFrom)} before starting`} />}
                      <button
                        type="button"
                        className={`tl-bar s-${r.status}${r.timing === "running" ? " running" : ""}`}
                        style={{ left: pct(r.start), width: `max(3px, ${pct(r.end - r.start)})` }}
                        onClick={() => onSelectJob(r.job)}
                        title={`${r.job.name}: started at +${formatDuration(r.start) || "0s"}, ${r.timing === "running" ? "still running" : `ran ${formatDuration(duration) || "0s"}`}`}
                        data-testid="timeline-bar"
                      >
                        <span className="visually-hidden">{r.job.name}</span>
                      </button>
                      <span className="tl-duration" style={{ left: `calc(${pct(r.end)} + 6px)` }}>
                        {r.timing === "running" ? "running" : formatDuration(duration) || "0s"}
                      </span>
                    </>
                  ) : (
                    <span className="tl-nobar muted">{NO_BAR[r.timing as keyof typeof NO_BAR]}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
