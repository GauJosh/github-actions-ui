// The History overview: four figures (this run, the baseline median, the change, how the other loaded runs ended)
// and run durations as columns, oldest first. Everything comes from the history model; a figure that is not available
// says why instead of showing a number, an unmeasured run keeps its slot without a height, and no change is given a cause.
import { useState, type ReactNode } from "react";
import type { Baseline, ChartPoint, Measure, Outcome, Outcomes, Trend } from "../../domain/insights/history";
import { chartSeries } from "../../domain/insights/history";
import { formatDuration } from "../format";

const dur = (ms: number) => formatDuration(ms) || "0s";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const OUTCOMES: Outcome[] = ["succeeded", "failed", "cancelled", "in progress", "other"];

type Props = {
  own: Measure;
  baseline: Baseline;
  outcomes: Outcomes;
  /** Other runs whose jobs could not be loaded (not counted anywhere). */
  notLoaded: number;
  trend: Trend;
  isOwn: (p: ChartPoint) => boolean;
  href: (p: ChartPoint) => string;
};

export function HistoryOverview({ own, baseline, outcomes, notLoaded, trend, isOwn, href }: Props) {
  return (
    <>
      <div className="history-kpis" data-testid="history-kpis">
        <Kpi id="duration" label="This run" value={"ms" in own ? dur(own.ms) : "Not measured"}>
          {"ms" in own ? (baseline.kind === "measured" ? `Baseline median ${dur(baseline.medianMs)}` : "No baseline to compare with") : `Its duration is unavailable (${own.unavailable}).`}
        </Kpi>
        {baseline.kind === "measured" ? (
          <>
            <Kpi id="median" label="Baseline median" value={dur(baseline.medianMs)}>
              {plural(baseline.samples, "earlier successful run")}, {dur(baseline.minMs)}–{dur(baseline.maxMs)}
            </Kpi>
            <Change baseline={baseline} />
          </>
        ) : (
          <Kpi id="median" label="Baseline median" value="Not available">
            {baseline.kind === "insufficient" ? `${baseline.samples} of ${baseline.needed} earlier successful runs needed` : baseline.why}
          </Kpi>
        )}
        <Kpi id="outcomes" label="Other runs succeeded" value={outcomes.runs ? `${outcomes.succeeded} of ${outcomes.runs}` : "No runs"}>
          {outcomes.runs
            ? OUTCOMES.filter((o) => o !== "succeeded" && outcomes[o] > 0)
                .map((o) => `${outcomes[o]} ${o}`)
                .join(" · ") || "none failed or were cancelled"
            : "No other runs of this workflow were loaded"}
          {notLoaded > 0 && `; ${plural(notLoaded, "run")} not loaded`}
        </Kpi>
      </div>
      <DurationChart trend={trend} baseline={baseline} isOwn={isOwn} href={href} />
    </>
  );
}

function Kpi({ id, label, value, children }: { id: string; label: string; value: string; children: ReactNode }) {
  return (
    <div className="history-kpi" data-testid={`kpi-${id}`}>
      <span className="history-kpi-label">{label}</span>
      <strong className="history-kpi-value">{value}</strong>
      <span className="history-kpi-note">{children}</span>
    </div>
  );
}

function Change({ baseline }: { baseline: Extract<Baseline, { kind: "measured" }> }) {
  const direction = baseline.deltaMs > 0 ? "slower" : baseline.deltaMs < 0 ? "faster" : "same";
  const value = direction === "same" ? "No change" : `${dur(Math.abs(baseline.deltaMs))} ${direction}`;
  return (
    <div className="history-kpi" data-testid="kpi-change" data-direction={direction}>
      <span className="history-kpi-label">Change from median</span>
      <strong className="history-kpi-value">
        {direction !== "same" && (
          <span className="history-kpi-arrow" aria-hidden="true">
            {direction === "slower" ? "▲" : "▼"}{" "}
          </span>
        )}
        {value}
      </strong>
      <span className="history-kpi-note">
        {baseline.ratio !== undefined && `${Math.round(baseline.ratio * 100)}% of the median; `}
        {baseline.faster} of {baseline.samples} earlier runs were faster
      </span>
    </div>
  );
}

const describe = (p: ChartPoint, own: boolean) =>
  `${own ? "This run" : `Run #${p.runNumber ?? p.runId}`}${p.attempt > 1 ? `, attempt ${p.attempt}` : ""}: ${p.outcome}, ${"ms" in p.duration ? dur(p.duration.ms) : `not measured (${p.duration.unavailable})`}`;

function DurationChart({ trend, baseline, isOwn, href }: { trend: Trend; baseline: Baseline; isOwn: (p: ChartPoint) => boolean; href: (p: ChartPoint) => string }) {
  const series = chartSeries(trend);
  const [active, setActive] = useState<number | null>(null);
  if (!series.points.length) return null;
  const max = Math.max(series.maxMs ?? 0, baseline.kind === "measured" ? baseline.medianMs : 0);
  const shown = series.points[active ?? series.points.findIndex(isOwn)] ?? series.points.at(-1)!;
  const present = OUTCOMES.filter((o) => series.points.some((p) => p.outcome === o && "ms" in p.duration));
  const unmeasured = series.points.length > series.measured;
  const median = baseline.kind === "measured" && max > 0 ? baseline.medianMs : undefined;
  const first = series.points[0]!;
  const last = series.points.at(-1)!;
  return (
    <figure className="history-chart" data-testid="history-chart" aria-labelledby="hist-chart-title">
      <figcaption>
        <span id="hist-chart-title" className="history-chart-title">
          Run duration, oldest to newest
        </span>
        <span className="note">
          First job start to last job end of each run attempt. {plural(series.measured, "run")} measured
          {series.points.length > series.measured && `, ${series.points.length - series.measured} not measured (shown as an empty slot)`}
          {baseline.kind === "measured" && `; the dashed line is the median of ${plural(baseline.samples, "earlier successful run")}`}. The table below lists every run.
        </span>
      </figcaption>
      <div className="history-plot" onMouseLeave={() => setActive(null)}>
        {max > 0 && <span className="history-axis-max">{dur(max)}</span>}
        {median !== undefined && (
          // Only the line is drawn in the plot; its value is in the legend, so it never covers a bar.
          <div className="history-median" style={{ bottom: `${(median / max) * 100}%` }} data-testid="history-chart-median" aria-hidden="true" />
        )}
        <ol className="history-cols">
          {series.points.map((p) => {
            const own = isOwn(p);
            const measured = "ms" in p.duration;
            const height = measured && max > 0 ? Math.max(1.5, ((p.duration as { ms: number }).ms / max) * 100) : 0;
            const label = describe(p, own);
            const mark = measured ? <span className={`history-col-bar outcome-${p.outcome.replace(" ", "-")}`} style={{ height: `${height}%` }} /> : <span className="history-col-empty" />;
            const events = { onMouseEnter: () => setActive(p.index), onFocus: () => setActive(p.index), onBlur: () => setActive(null) };
            return (
              <li key={`${p.runId}.${p.attempt}`} className={own ? "history-col history-col-own" : "history-col"} data-testid="history-chart-point" data-run={p.runId} data-attempt={p.attempt} data-outcome={p.outcome} data-measured={measured}>
                {own ? (
                  <span tabIndex={0} aria-label={label} {...events}>
                    {mark}
                  </span>
                ) : (
                  <a href={href(p)} aria-label={label} {...events}>
                    {mark}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="history-chart-foot">
        <span className="muted">#{first.runNumber ?? first.runId}</span>
        <span className="history-chart-detail" data-testid="history-chart-detail" aria-live="polite">
          {describe(shown, isOwn(shown))}
        </span>
        <span className="muted">#{last.runNumber ?? last.runId}</span>
      </div>
      {(present.length + (unmeasured ? 1 : 0) > 1 || median !== undefined) && (
        <ul className="history-legend" aria-label="Legend">
          {present.map((o) => (
            <li key={o}>
              <span className={`history-swatch outcome-${o.replace(" ", "-")}`} aria-hidden="true" />
              {o}
            </li>
          ))}
          {unmeasured && (
            <li>
              <span className="history-swatch history-col-empty" aria-hidden="true" />
              not measured
            </li>
          )}
          {median !== undefined && (
            <li data-testid="history-chart-median-label">
              <span className="history-swatch history-swatch-median" aria-hidden="true" />
              median {dur(median)}
            </li>
          )}
        </ul>
      )}
    </figure>
  );
}
