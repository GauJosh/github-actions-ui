// Status presentation. Every state has a distinct glyph AND a text label, so nothing relies on colour alone.
import { jobStatus, type NodeStatus } from "../domain/graph/build";

export const STATUS_LABEL: Record<NodeStatus, string> = {
  failure: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  in_progress: "Running",
  waiting: "Waiting",
  queued: "Queued",
  unknown: "Unknown",
  success: "Succeeded",
  neutral: "Neutral",
  skipped: "Skipped",
  not_run: "No job",
};

const GLYPH: Record<NodeStatus, string> = {
  failure: "✕",
  timed_out: "⧗",
  cancelled: "⊘",
  in_progress: "◐",
  waiting: "⏸",
  queued: "○",
  unknown: "?",
  success: "✓",
  neutral: "◇",
  skipped: "↷",
  not_run: "·",
};

/** Run and job objects share GitHub's status/conclusion fields. */
export const statusOf = jobStatus;

export function StatusIcon({ status }: { status: NodeStatus }) {
  return (
    <span className={`sicon s-${status}`} aria-hidden="true">
      {GLYPH[status]}
    </span>
  );
}

export function StatusBadge({ status, compact = false }: { status: NodeStatus; compact?: boolean }) {
  return (
    <span className={`sbadge s-${status}`} data-status={status}>
      <span aria-hidden="true">{GLYPH[status]}</span>
      {compact ? <span className="visually-hidden">{STATUS_LABEL[status]}</span> : <span>{STATUS_LABEL[status]}</span>}
    </span>
  );
}
