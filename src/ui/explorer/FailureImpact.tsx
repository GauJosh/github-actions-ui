// The failure impact panel, shown above the execution graph: each failure, what it needs, and what did not run
// because of it. It drives the graph's emphasis (see `impactFocus`) and reuses job selection and log links;
// nothing here fetches data.
import type { GraphNode, RunGraph } from "../../domain/graph/build";
import { DOWNSTREAM_TEXT, type DownstreamReason, type Failure, type Impact } from "../../domain/insights/impact";
import type { Job } from "../../domain/types";
import { absoluteTime } from "../format";
import { StatusIcon } from "../status";
import type { FocusRole, GraphFocus } from "./GraphCanvas";

/** The graph emphasis for every failure ("all") or one: failed jobs, their upstream, and what they affected. */
export function impactFocus(impact: Impact, selected: string): GraphFocus {
  const shown = selected === "all" ? impact.failures : impact.failures.filter((f) => f.key === selected);
  const rank: FocusRole[] = ["failed", "upstream", "blocked", "possibly", "ran"];
  const roles = new Map<string, FocusRole>();
  const set = (k: string, r: FocusRole) => {
    const cur = roles.get(k);
    if (!cur || rank.indexOf(r) < rank.indexOf(cur)) roles.set(k, r);
  };
  const ROLE: Record<DownstreamReason, FocusRole> = { blocked: "blocked", possibly: "possibly", "ran-anyway": "ran", recovery: "ran", cancelled: "failed", pending: "possibly" };
  for (const f of shown) {
    set(f.key, "failed");
    for (const k of f.upstream) set(k, "upstream");
    for (const d of f.downstream) set(d.key, ROLE[d.reason]);
  }
  return { roles, edges: new Set(shown.flatMap((f) => f.edges)), reveal: selected === "all" ? undefined : selected };
}

const KIND_TEXT = { failure: "failed", timed_out: "timed out", cancelled: "was cancelled" } as const;
const MAX = 12;

type Props = {
  impact: Impact;
  graph: RunGraph;
  selected: string;
  selectedJobId?: number;
  onSelect(key: string): void;
  onClose(): void;
  onSelectNode(node: GraphNode): void;
  onSelectJob(job: Job): void;
  stepHref(job: Job, step: number): string;
  /** Next steps of an investigation: compare with another execution, search this attempt. */
  compareHref?: string;
  searchHref?: string;
};

export function FailureImpact({ impact, graph, selected, selectedJobId, onSelect, onClose, onSelectNode, onSelectJob, stepHref, compareHref, searchHref }: Props) {
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const failed = impact.failures.filter((f) => f.kind !== "cancelled");
  const cancelled = impact.failures.length - failed.length;
  const blocked = new Set(impact.failures.flatMap((f) => f.downstream.filter((d) => d.reason === "blocked").map((d) => d.key)));
  const possibly = new Set(impact.failures.flatMap((f) => f.downstream.filter((d) => d.reason === "possibly").map((d) => d.key)));
  for (const k of blocked) possibly.delete(k);
  const shown = selected === "all" ? impact.failures : impact.failures.filter((f) => f.key === selected);
  const earliest = impact.earliest ? nodes.get(impact.earliest.key) : undefined;

  const nodeLink = (key: string) => {
    const n = nodes.get(key);
    if (!n) return <code>{key}</code>;
    return (
      <button type="button" className="linklike impact-node" onClick={() => onSelectNode(n)} data-node={key}>
        <StatusIcon status={n.status} /> {n.label}
      </button>
    );
  };

  return (
    <section className="impact" aria-labelledby="impact-heading" data-testid="failure-impact">
      <header className="impact-head">
        <h4 id="impact-heading">Failure impact</h4>
        <p className="impact-summary" data-testid="impact-summary">
          {failed.length ? `${failed.length} failure${failed.length === 1 ? "" : "s"}` : "No failed jobs"}
          {cancelled ? ` · ${cancelled} cancelled` : ""}
          {impact.dependencies === "workflow-file" && ` · ${blocked.size} not run because of a failure`}
          {possibly.size ? ` · ${possibly.size} possibly` : ""}
        </p>
        {compareHref && (
          <a href={compareHref} data-testid="impact-compare">
            Compare with another run
          </a>
        )}
        {searchHref && (
          <a href={searchHref} data-testid="impact-search">
            Search this attempt
          </a>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      {impact.earliest && earliest && (
        <p className="note" data-testid="impact-earliest">
          Earliest observed failure: <strong>{impact.earliest.job.name}</strong> at <time>{absoluteTime(impact.earliest.at)}</time>
          {impact.earliest.tied.length ? `, at the same second as ${impact.earliest.tied.map((k) => nodes.get(k)?.label ?? k).join(", ")}` : ""}. That is the
          order GitHub's timestamps show, not a confirmed cause.
        </p>
      )}

      {impact.failures.length > 1 && (
        <div className="impact-picker" role="group" aria-label="Failure to show">
          <button type="button" aria-pressed={selected === "all"} onClick={() => onSelect("all")}>
            All ({impact.failures.length})
          </button>
          {impact.failures.map((f) => (
            <button type="button" key={f.key} aria-pressed={selected === f.key} onClick={() => onSelect(f.key)} data-testid="impact-pick" data-key={f.key}>
              <StatusIcon status={f.status} /> {f.label}
            </button>
          ))}
        </div>
      )}

      <div className="impact-cards">
        {shown.map((f) => (
          <FailureCard key={f.key} f={f} impact={impact} nodeLink={nodeLink} selectedJobId={selectedJobId} onSelectJob={onSelectJob} stepHref={stepHref} />
        ))}
      </div>

      {impact.unrelatedSkipped.length > 0 && impact.dependencies === "workflow-file" && (
        <p className="note" data-testid="impact-unrelated">
          Not counted as impact: {impact.unrelatedSkipped.length} skipped job{impact.unrelatedSkipped.length === 1 ? " is" : "s are"} downstream of no failure (
          {impact.unrelatedSkipped
            .slice(0, 6)
            .map((k) => nodes.get(k)?.label ?? k)
            .join(", ")}
          {impact.unrelatedSkipped.length > 6 ? "…" : ""}), so {impact.unrelatedSkipped.length === 1 ? "it was" : "they were"} skipped by {impact.unrelatedSkipped.length === 1 ? "its" : "their"} own
          condition or for a reason GitHub does not report.
        </p>
      )}
      {impact.notes.length > 0 && (
        <ul className="impact-notes" data-testid="impact-notes">
          {impact.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ORDER: DownstreamReason[] = ["blocked", "possibly", "cancelled", "pending", "recovery", "ran-anyway"];

function FailureCard({
  f,
  impact,
  nodeLink,
  selectedJobId,
  onSelectJob,
  stepHref,
}: {
  f: Failure;
  impact: Impact;
  nodeLink(key: string): React.ReactNode;
  selectedJobId?: number;
  onSelectJob(job: Job): void;
  stepHref(job: Job, step: number): string;
}) {
  const groups = ORDER.map((r) => ({ reason: r, keys: f.downstream.filter((d) => d.reason === r).map((d) => d.key) })).filter((g) => g.keys.length);
  return (
    <article className={`impact-card k-${f.kind}`} data-testid="impact-card" data-key={f.key}>
      <h5>
        <StatusIcon status={f.status} /> {f.label} {KIND_TEXT[f.kind]}
        {impact.earliest?.key === f.key && <span className="tag">earliest observed</span>}
      </h5>

      <ul className="impact-jobs">
        {f.jobs.map((j) => (
          <li key={j.job.id}>
            <button type="button" className="linklike" aria-pressed={j.job.id === selectedJobId} onClick={() => onSelectJob(j.job)}>
              {j.job.name}
            </button>{" "}
            <span className="muted">{KIND_TEXT[j.kind]}</span>
            {j.step ? (
              <>
                {" "}
                at step <q>{j.step.name}</q> ·{" "}
                <a href={stepHref(j.job, j.step.number)} data-testid="impact-step-log">
                  log evidence
                </a>
              </>
            ) : j.kind !== "cancelled" ? (
              <span className="muted"> · GitHub's step data names no failed step (for example a runner or startup problem)</span>
            ) : null}
          </li>
        ))}
      </ul>

      <dl className="impact-facts">
        <dt>Upstream</dt>
        <dd data-testid="impact-upstream">
          {f.untraced ? (
            <span className="muted">Unknown: this job's dependencies are not known.</span>
          ) : f.upstream.length === 0 ? (
            <span className="muted">Needs no other job.</span>
          ) : (
            <>
              <span className="muted">
                {f.failedUpstream.length
                  ? `It ran after ${f.failedUpstream.length} upstream failure${f.failedUpstream.length === 1 ? "" : "s"} (its condition allowed that): `
                  : "Nothing it needs failed: "}
              </span>
              <Keys keys={f.upstream} nodeLink={nodeLink} />
            </>
          )}
        </dd>
        <dt>Downstream</dt>
        <dd data-testid="impact-downstream">
          {f.untraced ? (
            <span className="muted">Unknown.</span>
          ) : groups.length === 0 && f.declaredDownstream.length === 0 ? (
            <span className="muted">No job needs it.</span>
          ) : (
            <ul className="impact-groups">
              {groups.map((g) => (
                <li key={g.reason} data-reason={g.reason}>
                  <span className={`impact-reason r-${g.reason}`}>{DOWNSTREAM_TEXT[g.reason]}</span> <Keys keys={g.keys} nodeLink={nodeLink} />
                </li>
              ))}
              {f.declaredDownstream.length > 0 && (
                <li data-reason="declared">
                  <span className="impact-reason">Declared, no job in this attempt</span> {f.declaredDownstream.join(", ")}
                </li>
              )}
            </ul>
          )}
        </dd>
      </dl>
    </article>
  );
}

function Keys({ keys, nodeLink }: { keys: string[]; nodeLink(key: string): React.ReactNode }) {
  return (
    <span className="impact-keys">
      {keys.slice(0, MAX).map((k) => (
        <span key={k}>{nodeLink(k)}</span>
      ))}
      {keys.length > MAX && <span className="muted">+{keys.length - MAX} more</span>}
    </span>
  );
}
