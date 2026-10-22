// Details for the selected job: context in the graph, timing, steps, and the route into its log.
// A failed step is named only when GitHub's step data says so; otherwise the job is described as failed.
import { durationMs, jobStatus, type GraphEdge, type GraphNode, type RunGraph } from "../../domain/graph/build";
import { REVISION_TEXT } from "../../domain/graph/hierarchy";
import { defaultStepName, isCustomAction, type WorkflowStepDef } from "../../domain/graph/workflow-definition";
import type { EnvProvenance, GateState, JobRole, NodeEnvironment, RoleEvidence } from "../../domain/phases/phases";
import { hasLogOutput } from "../../domain/steps/step-map";
import type { Job } from "../../domain/types";
import { absoluteTime, formatDuration, shortSha } from "../format";
import { STATUS_LABEL, StatusBadge, StatusIcon } from "../status";

const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

type Props = {
  graph: RunGraph;
  node: GraphNode;
  job?: Job;
  logOpen: boolean;
  onOpenLog(): void;
  onCloseLog(): void;
  onSelectJob(job: Job, node: GraphNode): void;
  /** Release context, when the run has a phase overview. */
  phaseName?: string;
  role?: { role: JobRole; evidence: RoleEvidence };
  gate?: GateState;
  /** Inferred grouping: the job's environment, how it was established, and why. */
  environment?: NodeEnvironment;
  /** The job's steps as written in the workflow file, to identify the actions each step runs. */
  stepDefs?: WorkflowStepDef[];
  /** Link that opens the log at a step's output, keeping the run, phase and view; and the step shown. */
  stepHref?(stepNumber: number): string;
  selectedStep?: number;
};

const ROLE_LABEL: Record<JobRole, string> = {
  build: "Build",
  deploy: "Deployment",
  validation: "Validation",
  approval: "Approval gate",
  recovery: "Recovery (runs when an upstream job failed)",
  other: "Other",
};
const PROVENANCE_LABEL: Record<EnvProvenance, string> = {
  declared: "declared in the workflow",
  input: "from the caller's input",
  heuristic: "inferred",
  unknown: "unknown",
};

const EVIDENCE_LABEL: Record<RoleEvidence, string> = {
  declared: "declared in the repository's phase file",
  "if: failure()": "from its `if:` condition in the workflow file: it runs when an upstream job failed",
  environment: "from `environment:` in the workflow file",
};

export function JobDetails({ graph, node, job, logOpen, onOpenLog, onCloseLog, onSelectJob, phaseName, role, gate, environment, stepDefs, stepHref, selectedStep }: Props) {
  const label = new Map(graph.nodes.map((n) => [n.key, n]));
  const needs = graph.edges.filter((e) => e.to === node.key).map((e) => ({ node: label.get(e.from)!, edge: e }));
  const neededBy = graph.edges.filter((e) => e.from === node.key).map((e) => ({ node: label.get(e.to)!, edge: e }));
  const member = job ? node.members.find((m) => m.job.id === job.id) : undefined;

  return (
    <section className="panel details" id="job-details" aria-labelledby="details-heading" data-testid="job-details">
      <header className="panel-head">
        <div>
          <p className="eyebrow">{node.kind === "matrix" ? `Matrix · ${node.label}` : node.kind === "reusable" ? `Reusable workflow call · ${node.label}` : "Job"}</p>
          <h3 id="details-heading">{job ? job.name : node.label}</h3>
        </div>
        <StatusBadge status={job ? jobStatus(job) : node.status} />
      </header>

      {(phaseName || role || gate) && (
        <p className="job-context" data-testid="job-context">
          {phaseName && <span className="chip">phase: {phaseName}</span>}
          {role && (
            <span className={`chip role-${role.role}`} title={EVIDENCE_LABEL[role.evidence]}>
              {ROLE_LABEL[role.role]}
              {role.role === "deploy" && node.environment ? ` → ${node.environment}` : ""}
            </span>
          )}
          {role && <span className="muted"> ({EVIDENCE_LABEL[role.evidence]})</span>}
          {gate && (
            <span className={`chip gate g-${gate.state}`}>
              {gate.state === "pending" ? "awaiting approval" : `${gate.state}${gate.by ? ` by ${gate.by}` : ""}`}
              {gate.comment ? ` · “${gate.comment}”` : ""}
            </span>
          )}
        </p>
      )}
      {environment && (environment.environment || environment.reason !== "it runs before any deployment") && (
        <p className="note" data-testid="job-environment" data-provenance={environment.provenance}>
          Environment:{" "}
          {environment.environment ? <code>{environment.environment}</code> : <strong>not established</strong>} (<span className={`prov prov-${environment.provenance}`}>{PROVENANCE_LABEL[environment.provenance]}</span>):{" "}
          {environment.reason}.
        </p>
      )}
      {node.context && (
        <p className="note" data-testid="job-workflow-context">
          Inside <strong>{node.context.labels.join(" › ")}</strong>
          {(() => {
            const file = node.context.files.at(-1);
            return file ? (
              <>
                {" "}
                · defined in <code>{`${file.repo}/${file.path}`}</code> at {shortSha(file.revision)} ({REVISION_TEXT[file.source]}).
              </>
            ) : (
              ". Its workflow file was not read, so its steps and dependencies are not known."
            );
          })()}
          {node.environment && node.environmentEvidence === "input" && (
            <>
              {" "}
              Environment <code>{node.environment}</code>: the file's <code>environment:</code> is an input, filled with the calling job's literal value.
            </>
          )}
        </p>
      )}
      {node.kind === "reusable" && node.uses && (
        <p className="note" data-testid="call-origin">
          Calls <code>{node.uses}</code>
          {node.callFile ? ` (read at ${shortSha(node.callFile.revision)}: ${REVISION_TEXT[node.callFile.source]})` : node.resolvedWorkflow ? ` (resolved by GitHub to ${shortSha(node.resolvedWorkflow.sha)})` : ""}. Dependencies
          inside the called workflow are not shown.{node.callUnavailable ? ` ${node.callUnavailable}` : ""}
        </p>
      )}
      {member?.sameNameAs && (
        <p className="note" data-testid="same-name">
          GitHub reported more than one job named “{member.job.name}”, with the same result, for this definition and{" "}
          {member.sameNameAs.map((id, i) => (
            <span key={id}>
              {i ? ", " : ""}
              <code>{id}</code>
            </span>
          ))}
          . GitHub does not say which job ran which definition, so they are matched in order; both show the same result.
        </p>
      )}
      {member && node.kind !== "job" && <p className="note">This is “{member.label}” in {node.label}.</p>}

      <dl className="facts">
        <dt>Needs</dt>
        <dd>{needs.length ? needs.map((d) => <DepChip key={d.node.key} node={d.node} edge={d.edge} />) : graph.evidence.kind === "workflow-file" ? "nothing (a starting job)" : "unknown (no workflow file)"}</dd>
        <dt>Needed by</dt>
        <dd>{neededBy.length ? neededBy.map((d) => <DepChip key={d.node.key} node={d.node} edge={d.edge} />) : graph.evidence.kind === "workflow-file" ? "no later jobs" : "unknown (no workflow file)"}</dd>
        {job && <Timing job={job} />}
      </dl>

      {node.kind !== "job" && node.members.length > 1 && (
        <div className="member-picker" role="group" aria-label={`Jobs in ${node.label}`}>
          {node.members.map((m) => (
            <button key={m.job.id} className={`chip-button s-${jobStatus(m.job)}`} aria-pressed={m.job.id === job?.id} onClick={() => onSelectJob(m.job, node)}>
              <StatusIcon status={jobStatus(m.job)} /> {m.label}
            </button>
          ))}
        </div>
      )}

      {job && <Steps job={job} stepDefs={stepDefs} stepHref={job.conclusion === "skipped" ? undefined : stepHref} selectedStep={selectedStep} />}

      {job && (
        <div className="details-actions">
          {job.conclusion === "skipped" ? (
            <span className="muted">No log: the job was skipped.</span>
          ) : logOpen ? (
            <button onClick={onCloseLog}>Hide log</button>
          ) : (
            <button className="primary" onClick={onOpenLog} data-testid="open-log">
              Open log{FAILED.has(job.conclusion ?? "") ? " (failure evidence)" : ""}
            </button>
          )}
          {job.html_url && (
            <a href={job.html_url} target="_blank" rel="noreferrer noopener">
              Open job on GitHub
            </a>
          )}
        </div>
      )}
      {!job && <p className="note">Select one of the jobs above to see its steps and log.</p>}
    </section>
  );
}

function DepChip({ node, edge }: { node: GraphNode; edge?: GraphEdge }) {
  const caller = edge?.via === "call";
  return (
    <span className={`dep s-${node.status}${caller ? " caller-level" : ""}`} title={caller ? "A caller-level needs between reusable-workflow calls, not a needs inside a workflow" : undefined}>
      <StatusIcon status={node.status} /> {node.label}
      {node.context && <span className="muted"> ({node.context.labels.join(" › ")})</span>}
      {caller && <span className="muted"> · caller-level</span>}
    </span>
  );
}

function Timing({ job }: { job: Job }) {
  const queued = durationMs(job.created_at, job.started_at);
  const ran = durationMs(job.started_at, job.completed_at);
  return (
    <>
      {queued !== undefined && (
        <>
          <dt>Queued for</dt>
          <dd>{formatDuration(queued)}</dd>
        </>
      )}
      <dt>Started</dt>
      <dd>{job.started_at ? absoluteTime(job.started_at) : "not started"}</dd>
      <dt>Duration</dt>
      <dd>{ran !== undefined ? formatDuration(ran) : job.status === "completed" ? "not reported" : "still running"}</dd>
      {job.runner_name && (
        <>
          <dt>Runner</dt>
          <dd>{job.runner_name}</dd>
        </>
      )}
    </>
  );
}

function Steps({ job, stepDefs, stepHref, selectedStep }: { job: Job; stepDefs?: WorkflowStepDef[]; stepHref?(n: number): string; selectedStep?: number }) {
  const usesOf = (name: string) => stepDefs?.find((d) => defaultStepName(d) === name)?.uses;
  if (!job.steps) return <p className="state">GitHub returned no step data for this job.</p>;
  if (job.steps.length === 0) return <p className="note">No steps were reported{job.conclusion === "skipped" ? " (the job was skipped)" : ""}.</p>;
  const failedSteps = job.steps.filter((s) => s.status === "completed" && FAILED.has(s.conclusion ?? ""));
  const jobFailed = job.status === "completed" && FAILED.has(job.conclusion ?? "");
  return (
    <div className="steps-block">
      {jobFailed && (
        <p className={failedSteps.length ? "finding" : "note"} data-testid="failure-summary">
          {failedSteps.length
            ? `GitHub's step data identifies the failed step: ${failedSteps.map((s) => s.name).join(", ")}.`
            : `The job ${STATUS_LABEL[jobStatus(job)].toLowerCase()}, but GitHub's step data does not identify a failed step.`}
        </p>
      )}
      {jobFailed && stepHref && failedSteps[0] && (
        <p className="failed-step-action">
          <a href={stepHref(failedSteps[0].number)} data-testid="failed-step-link">
            Show the failed step's log evidence
          </a>
        </p>
      )}
      <ol className="steps-list" aria-label="Steps">
        {job.steps.map((s) => {
          const st = jobStatus(s);
          return (
            <li key={s.number} className={`step s-${st}`} data-failed={FAILED.has(s.conclusion ?? "") || undefined} aria-current={s.number === selectedStep ? "step" : undefined}>
              <StatusIcon status={st} />
              <span className="step-num">{s.number}</span>
              <span className="step-name">
                {stepHref && hasLogOutput(s) ? (
                  <a href={stepHref(s.number)} data-testid="step-link" title="Open the log at this step's output">
                    {s.name}
                  </a>
                ) : (
                  s.name
                )}
                {usesOf(s.name) && (
                  <code className={isCustomAction(usesOf(s.name)) ? "action custom" : "action"} title={isCustomAction(usesOf(s.name)) ? "Custom action (repository or organisation)" : "GitHub action"}>
                    {isCustomAction(usesOf(s.name)) ? "custom action " : ""}
                    {usesOf(s.name)}
                  </code>
                )}
              </span>
              <span className="step-time">{formatDuration(durationMs(s.started_at, s.completed_at))}</span>
              <span className="visually-hidden">{STATUS_LABEL[st]}</span>
            </li>
          );
        })}
      </ol>
      {stepHref && <p className="note">Select a step to open the log at its output. Step boundaries come from the runner's log markers and may not always be exact.</p>}
    </div>
  );
}
