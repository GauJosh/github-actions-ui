// One emergency execution: snapshot and commit, integrity and network evidence, job and step progress with exit
// codes, logs, outputs and the final result. Polls while the execution runs. Security review H2: who prepared, started
// and approved it, and, while it waits, the approval decision for approvers.
import { useEffect, useState } from "react";
import { executor, type ExecutionDetail, type ExecutionMeta } from "../../emergency/executor-client";
import type { JobView, StepView } from "../../emergency/events";
import { can, emergencyHref, errorText, StatusTag, useSession } from "./EmergencyView";

/** Log line sources: the runner's own messages, and the workflow's output streams. */
const SOURCE_TAG: Record<string, string> = { runner: "runner", stdout: "out", stderr: "err" };
const SOURCE_LABEL: Record<string, string> = { runner: "Message from the runner", stdout: "Workflow output (stdout)", stderr: "Workflow output (stderr)" };
const ms = (n?: number) => (n === undefined ? "" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

export function ExecutionPage({ id }: { id: string }) {
  const session = useSession();
  const [data, setData] = useState<ExecutionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    let live = true;
    const load = async () => {
      try {
        const d = await executor.getExecution(id);
        if (!live) return;
        setData(d);
        setError(null);
        const done = !["pending", "running"].includes(d.view.status) && d.job.state !== "running" && d.job.state !== "pending";
        if (!done) timer = window.setTimeout(load, 2000);
      } catch (e) {
        if (!live) return;
        setError(errorText(e));
        timer = window.setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id, reload]);

  if (!data) return error ? <p className="state state-error">{error}</p> : <p className="state">Loading execution…</p>;
  const { meta, view, job } = data;
  const running = view.status === "running" || view.status === "pending";
  const mine = meta.initiatedBy?.id === session.user.id;
  const mayStop = (mine && can(session, "executions.cancel-own")) || can(session, "executions.cancel-any");
  return (
    <div className="emergency-execution">
      <p>
        <a href="#/emergency">← Emergency execution</a>
      </p>
      <section className="panel">
        <div className="panel-head">
          <h3>
            Execution <span className="mono">{meta.id}</span> <StatusTag status={view.status} />
          </h3>
          {running && mayStop && (
            <button type="button" className="danger" onClick={() => void executor.stopExecution(id).then(() => setReload((n) => n + 1), (e) => setError(errorText(e)))}>
              {meta.state === "awaiting-approval" || meta.state === "approved" ? "Cancel request" : "Stop"}
            </button>
          )}
        </div>
        {error && <p className="state state-error">{error}</p>}
        {meta.approval && <Approval meta={meta} onChanged={() => setReload((n) => n + 1)} />}
        <dl className="manifest-facts" data-testid="execution-facts">
          <dt>Prepared by</dt>
          <dd data-testid="prepared-by">{meta.preparedBy?.name ?? "— (before sign-in)"}</dd>
          <dt>Started by</dt>
          <dd data-testid="initiated-by">{meta.initiatedBy?.name ?? "— (the shared operator token, before sign-in)"}</dd>
          <dt>Snapshot</dt>
          <dd>
            <a href={emergencyHref({ page: "snapshot", id: meta.snapshotId })}>
              {meta.snapshotName} v{meta.snapshotVersion}
            </a>{" "}
            <span className="mono muted">sha256:{meta.snapshotId.slice(0, 16)}…</span>
          </dd>
          <dt>Source commit</dt>
          <dd className="mono" data-testid="execution-sha">
            {view.source ? `${view.source.repository}@${view.source.sha}` : "—"}
          </dd>
          <dt>Workflow</dt>
          <dd className="mono">{meta.workflow}</dd>
          <dt>Inputs</dt>
          <dd className="mono">{Object.keys(meta.inputs).length ? Object.entries(meta.inputs).map(([k, v]) => `${k}=${v}`).join(", ") : "none"}</dd>
          <dt>Secret</dt>
          <dd>
            {meta.secretName ? (
              <>
                <span className="mono">{meta.secretName}</span>
                {meta.secretKeys && <span className="muted"> — keys {meta.secretKeys.join(", ")} only</span>}
              </>
            ) : (
              "none"
            )}{" "}
            (values are never shown)
          </dd>
          <dt>Network isolation</dt>
          <dd data-testid="execution-isolation" className={meta.network === "isolated" && meta.isolation?.state === "enforced" ? "" : "warn-text"}>
            {meta.network === "isolated"
              ? meta.isolation?.state === "enforced"
                ? `Isolated; NetworkPolicy enforcement verified by the canary at ${meta.isolation.checkedAt}`
                : `Isolated mode, but enforcement was not verified (${meta.isolation?.state ?? "record predates the check"})`
              : meta.network === "egress"
                ? "NOT isolated (egress mode): public internet reachable, including GitHub by IP address"
                : "NOT isolated (legacy github-blocked mode: only GitHub's hostnames were blocked)"}
          </dd>
          <dt>Kubernetes Job</dt>
          <dd>
            <span className="mono">{meta.jobName}</span> — {job.state}
            {job.reason && <span className="warn-text"> ({job.reason})</span>}
          </dd>
          <dt>Snapshot integrity</dt>
          <dd data-testid="execution-verified">{view.verified ? (view.verified.ok ? `verified in the runner (${view.verified.files} files)` : `FAILED: ${view.verified.problems.join("; ")}`) : "not yet checked"}</dd>
          <dt>Runner's events</dt>
          <dd data-testid="execution-stream" className={view.stream && !view.stream.ok && !view.stream.legacy ? "warn-text" : ""}>
            {!view.stream
              ? "not yet read"
              : view.stream.legacy
                ? "not verifiable (recorded before events were authenticated)"
                : view.stream.ok
                  ? `authenticated (${view.stream.events} events${view.stream.complete ? ", complete" : " so far"})`
                  : `FAILED after ${view.stream.events} events: ${view.stream.problem}`}
          </dd>
          {view.exitCode !== undefined && (
            <>
              <dt>Runner exit code</dt>
              <dd className="mono">{view.exitCode}</dd>
            </>
          )}
          <dt>Runner's hostname probe (not proof)</dt>
          <dd data-testid="execution-network">
            {view.network.length === 0
              ? meta.network === "isolated"
                ? "checking…"
                : "not checked"
              : view.network.map((n) => (
                  <span key={n.host} className={n.reachable ? "warn-text" : ""}>
                    {n.host}: {n.reachable ? "REACHABLE" : "unreachable"} <span className="muted">({n.detail})</span>
                    <br />
                  </span>
                ))}
          </dd>
          {view.durationMs !== undefined && (
            <>
              <dt>Duration</dt>
              <dd>{ms(view.durationMs)}</dd>
            </>
          )}
          {view.reason && (
            <>
              <dt>Result</dt>
              <dd className={view.status === "success" ? "" : "warn-text"} data-testid="execution-reason">
                {view.reason}
              </dd>
            </>
          )}
        </dl>
        {view.status === "success" && (
          <p className="note" data-testid="reconcile-note">
            This run happened outside GitHub: no check, status or deployment record was created there. After GitHub recovers, re-run or record it there as your process requires.
          </p>
        )}
      </section>
      <section className="panel">
        <h3>Jobs and steps</h3>
        {view.jobs.length === 0 ? <p className="muted">No job has started.</p> : view.jobs.map((j) => <JobCard key={j.job} job={j} logs={view.logs} />)}
      </section>
      {view.annotations.length > 0 && (
        <section className="panel">
          <h3>Annotations</h3>
          <ul className="diag">
            {view.annotations.map((a, i) => (
              <li key={i} className={`ann-${a.level}`}>
                <strong>{a.level}</strong> {a.message} <span className="muted">({a.source === "workflow" ? "reported by the workflow, " : ""}{a.job} step {a.step})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function JobCard({ job, logs }: { job: JobView; logs: { text: string; stream: string }[] }) {
  return (
    <div className="exec-job" data-testid="exec-job">
      <p className="exec-job-head">
        <StatusTag status={job.status} /> <strong className="mono">{job.job}</strong>
        {job.name !== job.job.split("/").at(-1) && <span> — {job.name}</span>}
        {job.needs.length > 0 && <span className="muted"> · needs {job.needs.join(", ")}</span>}
        {job.reason && <span className="muted"> · {job.reason}</span>}
      </p>
      {Object.keys(job.outputs).length > 0 && (
        <p className="mono muted exec-outputs">
          outputs: {Object.entries(job.outputs).map(([k, v]) => `${k}=${v}`).join(", ")}
        </p>
      )}
      {job.steps.length > 0 && (
        <ol className="exec-steps">
          {job.steps.map((s) => (
            <StepRow key={s.step} step={s} logs={logs} />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepRow({ step, logs }: { step: StepView; logs: { text: string; stream: string }[] }) {
  const [open, setOpen] = useState(step.status === "failure");
  return (
    <li className="exec-step" data-testid="exec-step">
      <button type="button" className="link-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <StatusTag status={step.status} /> {step.name}
      </button>
      <span className="muted">
        {" "}
        exit {step.exitCode ?? "–"} · {ms(step.durationMs)}
        {step.reason && ` · ${step.reason}`}
      </span>
      {Object.keys(step.outputs).length > 0 && <span className="mono muted"> · {Object.entries(step.outputs).map(([k, v]) => `${k}=${v}`).join(", ")}</span>}
      {open && (
        // Each line is labelled with its source, so workflow output can't pass itself off as the runner's (review H3).
        <pre className="exec-log" data-testid="exec-log">
          {step.logs.length
            ? step.logs.map((i) => (
                <span key={i} className={`log-line log-${logs[i]!.stream}`}>
                  <span className="log-src" title={SOURCE_LABEL[logs[i]!.stream] ?? logs[i]!.stream}>
                    {SOURCE_TAG[logs[i]!.stream] ?? "?"}
                  </span>
                  {logs[i]!.text}
                  {"\n"}
                </span>
              ))
            : "(no output)"}
        </pre>
      )}
    </li>
  );
}

/** The approval request and its decision; approvers (other than the initiator and preparer) decide here. */
function Approval({ meta, onChanged }: { meta: ExecutionMeta; onChanged: () => void }) {
  const session = useSession();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = meta.approval!;
  const involved = meta.initiatedBy?.id === session.user.id || meta.preparedBy?.id === session.user.id;
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const r = await executor.decide(meta.id, decision, a.requestDigest, comment.trim());
      if (r.startProblem) setError(`Approved, but not started yet: ${r.startProblem.error}`);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`approval approval-${meta.state}`} data-testid="approval">
      <p>
        <strong>{meta.state === "awaiting-approval" ? "Waiting for approval" : a.decision === "approved" ? `Approved by ${a.decidedBy?.name}` : a.decision === "rejected" ? `Rejected by ${a.decidedBy?.name}` : `Approval: ${meta.state}`}</strong>
        {a.comment && <span className="muted"> — “{a.comment}”</span>}
      </p>
      <ul className="muted">
        {a.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="muted">
        The decision covers exactly this request (digest <span className="mono" data-testid="request-digest">{a.requestDigest.slice(0, 16)}…</span>): this snapshot, workflow, inputs, variables, network mode and Secret binding. Any change to the binding invalidates it.
      </p>
      {meta.state === "awaiting-approval" &&
        (can(session, "executions.approve") && !involved ? (
          <div className="approval-actions">
            <input placeholder="Comment (change or incident reference)" value={comment} onChange={(e) => setComment(e.target.value)} data-testid="approval-comment" />
            <button type="button" disabled={busy} onClick={() => void decide("approve")} data-testid="approve">
              Approve and start
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void decide("reject")} data-testid="reject">
              Reject
            </button>
          </div>
        ) : (
          <p className="muted" data-testid="approval-not-yours">
            {involved ? "You started this execution or prepared its snapshot, so another approver must decide." : "An approver must decide."}
          </p>
        ))}
      {meta.state === "approved" && meta.initiatedBy?.id === session.user.id && (
        <button type="button" disabled={busy} onClick={() => void executor.startApproved(meta.id).then(onChanged, (e) => setError(errorText(e)))}>
          Start now
        </button>
      )}
      {error && (
        <p className="state state-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
