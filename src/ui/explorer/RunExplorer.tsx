// A run's detail view, in three levels:
//   1. release overview: the run's phases (CI, Dev, Test, Stage, Prod…) at a glance, and why it stopped;
//   2. phase detail: one phase's jobs and real dependencies (and a reusable call as its own context);
//   3. job detail: steps, custom actions and the log.
// The raw execution graph is always available as a second view, and is the only view when jobs cannot be
// grouped confidently. Data is fetched on demand; the URL keeps the view, phase, job and log.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Environment } from "../../app/environment";
import { calledWorkflowGraph, durationMs, type GraphNode } from "../../domain/graph/build";
import { treeAt } from "../../domain/graph/hierarchy";
import { layoutGraph } from "../../domain/graph/layout";
import { buildOverview, gatesFor, type ReleaseOverview as Overview } from "../../domain/phases/phases";
import { routeToHash, type Route } from "../../domain/run-url";
import type { Job, Run, RunRef } from "../../domain/types";
import { GalleryStrip } from "../../fixture-mode/gallery";
import { loadGateEvidence, loadPhaseManifest } from "../../runs/release";
import { graphFor, loadWorkflowDefinition, rootFile } from "../../runs/workflow-graph";
import { loadWorkflowTree } from "../../runs/workflow-tree";
import { absoluteTime, firstLine, formatDuration, relativeTime, shortSha } from "../format";
import { LogPanel } from "../LogPanel";
import { ErrorState } from "../RepoDashboard";
import { StatusBadge, StatusIcon, statusOf } from "../status";
import { GraphCanvas, nodeHeight } from "./GraphCanvas";
import { JobDetails } from "./JobDetails";
import { JobList } from "./JobList";
import { PhaseDetail } from "./PhaseDetail";
import { ReleaseOverview } from "./ReleaseOverview";

type Props = { env: Environment; run: RunRef; route: Route };

export function RunExplorer({ env, run: ref, route }: Props) {
  const { jobId, log, line, step } = route;
  const key = [env.mode, ref.owner, ref.repo, ref.runId];
  const run = useQuery({ queryKey: ["run", ...key], queryFn: () => env.client.getRun(ref) });
  const jobs = useQuery({ queryKey: ["jobs", ...key], queryFn: () => env.client.getJobs(ref) });
  const definition = useQuery({
    queryKey: ["workflow-definition", ...key, run.data?.head_sha, run.data?.path],
    queryFn: () => loadWorkflowDefinition(env.client, ref, run.data!),
    enabled: run.isSuccess,
    staleTime: Infinity,
  });
  const def = definition.data && "definition" in definition.data ? definition.data.definition : null;
  const manifest = useQuery({
    queryKey: ["phase-manifest", ...key, run.data?.head_sha],
    queryFn: () => loadPhaseManifest(env.client, ref, run.data!),
    enabled: Boolean(def),
    staleTime: Infinity,
  });
  // Called (reusable) workflows, recursively and bounded, at the revisions this run used. Files only: no logs.
  const callsSomething = Boolean(def?.jobs.some((j) => j.uses));
  const hierarchy = useQuery({
    queryKey: ["workflow-tree", ...key, run.data?.head_sha, run.data?.path],
    queryFn: () => {
      const result = definition.data as Extract<NonNullable<typeof definition.data>, { definition: unknown }>;
      return loadWorkflowTree(env.client, run.data!, { definition: result.definition, file: rootFile(ref, run.data!, result) });
    },
    enabled: callsSomething,
    staleTime: Infinity,
  });
  const treePending = callsSomething && hierarchy.isPending;
  const [nodeKey, setNodeKey] = useState<string | undefined>();

  const graph = useMemo(() => {
    if (!run.data || !jobs.data || definition.isPending || treePending) return null;
    const result = definition.data ?? { unavailableReason: "The workflow file could not be loaded." };
    return graphFor(ref, run.data, jobs.data, result, hierarchy.data);
  }, [ref, run.data, jobs.data, definition.data, definition.isPending, treePending, hierarchy.data]);
  const hasEnvironments = Boolean(graph?.nodes.some((n) => n.environment));
  const anyWaiting = Boolean(jobs.data?.some((j) => j.status === "waiting"));
  const gateEvidence = useQuery({
    queryKey: ["gates", ...key, anyWaiting],
    queryFn: () => loadGateEvidence(env.client, ref, anyWaiting),
    enabled: hasEnvironments && jobs.isSuccess,
    staleTime: 60_000,
  });
  const layout = useMemo(() => (graph ? layoutGraph(graph.nodes.map((n) => ({ key: n.key, height: nodeHeight(n) })), graph.edges) : null), [graph]);

  const releaseLoading = Boolean(def) && (manifest.isPending || (hasEnvironments && gateEvidence.isPending));
  const overview = useMemo((): Overview | { unavailable: string } | null => {
    if (!graph || releaseLoading) return null;
    const gates = gatesFor(graph, gateEvidence.data?.approvals ?? null, gateEvidence.data?.pending ?? null);
    return buildOverview(graph, def, { manifest: manifest.data?.manifest ?? null, gates });
  }, [graph, def, manifest.data, gateEvidence.data, releaseLoading]);
  const release = overview && !("unavailable" in overview) ? overview : null;
  // The raw graph keeps every edge, structured by declared service groups (lanes) and phases (one framed subgraph each).
  const rawLanes = useMemo(() => (release?.nodeGroup.size ? release.nodeGroup : undefined), [release]);
  const rawColumns = useMemo(() => {
    if (!release) return undefined;
    const m = new Map<string, string>();
    for (const p of release.phases) for (const k of p.nodeKeys) m.set(k, p.name);
    return m;
  }, [release]);
  const view: "overview" | "graph" = route.view === "graph" || (overview && !release) ? "graph" : "overview";

  const selectedJob = jobs.data?.find((j) => j.id === jobId);
  const selectedNode = graph?.nodes.find((n) => (selectedJob ? n.members.some((m) => m.job.id === selectedJob.id) : n.key === nodeKey));
  // A job inside a call shown as one node: its steps are defined in the called workflow (from the loaded hierarchy).
  const callTree = selectedNode?.kind === "reusable" && selectedNode.callId && hierarchy.data ? treeAt(hierarchy.data.tree, selectedNode.callId) : undefined;
  const phaseOfNode = (k?: string) => (k && release ? (release.nodePhase.get(k) ?? (release.unassignedKeys.includes(k) ? "other" : undefined)) : undefined);
  const activePhase = view === "overview" ? (route.phase ?? phaseOfNode(selectedNode?.key)) : undefined;

  const go = (next: Partial<Route>) => {
    window.location.hash = routeToHash({ run: ref, view: route.view, phase: route.phase, ...next });
  };
  // The open log's place (step and line), kept when switching views so the user does not lose it.
  const logPlace = selectedJob && log ? { log, step, line } : {};
  // A link into the selected job's log that keeps the run, view, phase and call.
  const placeHref = (place: { step?: number; line?: number }) =>
    routeToHash({ run: ref, view: route.view, phase: activePhase, call: route.call, jobId: selectedJob?.id, log: true, ...place });
  const logLinks = { line: (n: number) => placeHref({ step, line: n }), step: (n: number) => placeHref({ step: n }) };
  const selectJob = (job: Job) => {
    setNodeKey(undefined);
    const node = graph?.nodes.find((n) => n.members.some((m) => m.job.id === job.id));
    const phase = view === "overview" ? (phaseOfNode(node?.key) ?? route.phase) : undefined;
    go({ jobId: job.id, phase, call: phase === route.phase ? route.call : undefined, log: undefined, line: undefined });
  };
  const selectNode = (node: GraphNode) => {
    if (node.external) {
      go({ phase: node.external.phaseId ?? "other", call: undefined, jobId: undefined });
      return;
    }
    const failed = node.members.find((m) => m.job.conclusion === "failure" || m.job.conclusion === "timed_out");
    const pick = failed ?? node.members[0];
    if (pick) selectJob(pick.job);
    else {
      setNodeKey(node.key);
      go({ jobId: undefined });
    }
  };
  const selectPhase = (id: string) => go({ phase: id === activePhase ? undefined : id, call: undefined, jobId: undefined, log: undefined });
  const refresh = () => {
    void run.refetch();
    void jobs.refetch();
    void definition.refetch();
    void hierarchy.refetch();
    void manifest.refetch();
    void gateEvidence.refetch();
  };

  if (run.isPending) return <p className="state">Loading run…</p>;
  if (run.isError) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  const r = run.data;
  const loadingState = jobs.isPending
    ? "Loading jobs…"
    : definition.isPending
      ? `Reading the workflow file at ${shortSha(r.head_sha)}…`
      : treePending
        ? "Reading the called (reusable) workflows at the revisions this run used…"
        : releaseLoading
        ? "Reading the release structure…"
        : null;

  const roleOf = selectedNode ? release?.roles.get(selectedNode.key) : undefined;
  const gateOf = selectedNode?.environment ? release?.gates.get(selectedNode.environment) : undefined;
  const innerDefinition = callTree?.definition ?? null;
  const innerYamlId =
    selectedNode?.kind === "reusable" && innerDefinition && selectedJob
      ? calledWorkflowGraph(selectedNode, innerDefinition, { file: { path: "", revision: "" } }).nodes.find((n) => n.members.some((m) => m.job.id === selectedJob.id))?.yamlId
      : undefined;
  const stepDefs = selectedNode?.kind === "reusable" ? innerDefinition?.jobs.find((j) => j.id === innerYamlId)?.steps : selectedNode?.stepDefs;
  const phaseName = release && selectedNode ? release.phases.find((p) => p.id === release.nodePhase.get(selectedNode.key))?.name : undefined;
  const sections = release
    ? [
        ...release.phases.map((p) => ({ id: p.id, title: p.name, keys: p.nodeKeys })),
        ...(release.unassignedKeys.length ? [{ id: "other", title: "Other jobs", keys: release.unassignedKeys }] : []),
      ]
    : undefined;

  return (
    <div className="explorer">
      {__FIXTURE_MODE__ && env.mode === "fixtures" && <GalleryStrip run={ref} view={route.view} />}
      <RunHeader run={r} runRef={ref} jobs={jobs.data} onRefresh={refresh} refreshing={run.isFetching || jobs.isFetching} />

      <div className="view-switch" role="tablist" aria-label="Run views">
        <button
          role="tab"
          aria-selected={view === "overview"}
          disabled={!release}
          title={overview && "unavailable" in overview ? overview.unavailable : undefined}
          onClick={() => go({ view: undefined, phase: phaseOfNode(selectedNode?.key) ?? route.phase, jobId: selectedJob?.id, ...logPlace })}
        >
          Release overview
        </button>
        <button role="tab" aria-selected={view === "graph"} onClick={() => go({ view: "graph", phase: undefined, call: undefined, jobId: selectedJob?.id, ...logPlace })}>
          Execution graph (all jobs)
        </button>
        {overview && "unavailable" in overview && (
          <span className="muted" data-testid="overview-unavailable">
            Release overview unavailable: {overview.unavailable}
          </span>
        )}
      </div>

      <section className="panel graph-panel" aria-label={view === "overview" ? "Release overview" : "Execution graph"} id="graph">
        {loadingState ? (
          <p className="state">{loadingState}</p>
        ) : jobs.isError ? (
          <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
        ) : jobs.data?.length === 0 ? (
          <p className="state">GitHub returned no jobs for this run (it may not have started, or its data has expired).</p>
        ) : graph && layout && view === "overview" && release ? (
          <ReleaseOverview
            overview={release}
            graph={graph}
            selectedPhase={activePhase}
            onSelectPhase={selectPhase}
            onShowJob={(k) => {
              const n = graph.nodes.find((x) => x.key === k);
              if (!n) return;
              selectNode(n);
              // The job details are below the overview and phase detail: bring them into view.
              window.setTimeout(() => document.getElementById("job-details")?.scrollIntoView({ block: "start" }), 50);
            }}
          />
        ) : (
          graph &&
          layout && (
            <>
              <header className="panel-head">
                <h3 id="graph-heading">Execution graph</h3>
                <Evidence graph={graph} />
              </header>
              <GraphCanvas
                graph={graph}
                lanes={rawLanes}
                groups={rawColumns}
                selectedKey={selectedNode?.key}
                selectedJobId={selectedJob?.id}
                onSelectNode={selectNode}
                onSelectJob={(job) => selectJob(job)}
                annotations={release ? { roles: release.roles, gates: release.gates } : undefined}
              />
            </>
          )
        )}
      </section>

      {graph && release && view === "overview" && activePhase && !loadingState && (
        <PhaseDetail
          env={env}
          graph={graph}
          overview={release}
          phaseId={activePhase}
          call={route.phase === activePhase ? route.call : undefined}
          selectedJobId={selectedJob?.id}
          onSelectNode={selectNode}
          onSelectJob={(job) => selectJob(job)}
          onOpenCall={(node) => go({ phase: activePhase, call: node.callId ?? node.yamlId, jobId: undefined })}
          onCloseCall={() => go({ phase: activePhase, call: undefined })}
        />
      )}

      {graph && layout && !loadingState && (
        <div className="explorer-lower">
          <JobList
            graph={graph}
            layout={layout}
            selectedKey={selectedNode?.key}
            selectedJobId={selectedJob?.id}
            onSelectNode={selectNode}
            onSelectJob={(job) => selectJob(job)}
            sections={view === "overview" ? sections : undefined}
          />
          {selectedNode ? (
            <JobDetails
              graph={graph}
              node={selectedNode}
              job={selectedJob}
              logOpen={Boolean(log)}
              onOpenLog={() => selectedJob && go({ jobId: selectedJob.id, phase: activePhase, log: true })}
              onCloseLog={() => selectedJob && go({ jobId: selectedJob.id, phase: activePhase })}
              onSelectJob={(job) => selectJob(job)}
              phaseName={phaseName}
              role={roleOf}
              gate={gateOf}
              environment={release?.environments.get(selectedNode.key)}
              stepDefs={stepDefs}
              stepHref={selectedJob ? (n) => placeHref({ step: n }) : undefined}
              selectedStep={step}
            />
          ) : (
            <FailureOverview graph={graph} onSelect={selectNode} />
          )}
        </div>
      )}

      {selectedJob && log && (
        <div className="log-wrap">
          <a href="#graph" className="back-to-graph" onClick={(e) => (e.preventDefault(), document.getElementById("graph")?.scrollIntoView())}>
            ↑ Back to the {view === "overview" ? "release overview" : "graph"}
          </a>
          <LogPanel env={env} jobRef={{ ...ref, jobId: selectedJob.id }} job={selectedJob} line={line} step={step} links={logLinks} />
        </div>
      )}
      {jobId !== undefined && jobs.isSuccess && !selectedJob && <p className="state state-error">Job {jobId} is not part of this run's latest attempt.</p>}
    </div>
  );
}

function RunHeader({ run, runRef, jobs, onRefresh, refreshing }: { run: Run; runRef: RunRef; jobs?: Job[]; onRefresh(): void; refreshing: boolean }) {
  const starts = jobs?.map((j) => j.started_at).filter((t): t is string => !!t) ?? [];
  const ends = jobs?.map((j) => j.completed_at).filter((t): t is string => !!t) ?? [];
  const allDone = Boolean(jobs?.length) && jobs!.every((j) => j.status === "completed");
  const span = allDone && starts.length && ends.length ? durationMs(starts.sort()[0], ends.sort().at(-1)) : undefined;
  const commit = firstLine(run.head_commit?.message);
  const started = run.run_started_at ?? run.created_at;
  return (
    <header className="page-head run-head">
      <div className="run-head-main">
        <nav aria-label="Breadcrumb" className="crumbs">
          <a href="#/">Repositories</a> / <a href={routeToHash({ repo: runRef })}>{`${runRef.owner}/${runRef.repo}`}</a> / <span>Run{run.run_number !== undefined ? ` #${run.run_number}` : ""}</span>
        </nav>
        <h2>
          <StatusBadge status={statusOf(run)} /> {run.display_title}
        </h2>
        <p className="run-sub">
          {run.name && run.name !== run.display_title && <span className="run-workflow">{run.name}</span>}
          {run.path && <code>{run.path}</code>}
          {run.run_attempt > 1 && <span>attempt {run.run_attempt}</span>}
          <span className="chip">{run.event}</span>
          {run.pull_requests?.map((pr) => (
            <a key={pr.number} className="chip" href={`https://github.com/${runRef.owner}/${runRef.repo}/pull/${pr.number}`} target="_blank" rel="noreferrer noopener">
              PR #{pr.number}
            </a>
          ))}
          {run.head_branch && <span className="chip branch">{run.head_branch}</span>}
          <span className="mono">{shortSha(run.head_sha)}</span>
          {commit && commit !== run.display_title && <span className="commit">{commit}</span>}
        </p>
        <p className="run-sub muted">
          {run.actor && <span>by {run.actor.login}</span>}
          {started && <time title={absoluteTime(started)}>started {relativeTime(started)}</time>}
          {span !== undefined && <span title="From the first job start to the last job completion">ran {formatDuration(span)}</span>}
          {run.status !== "completed" && <span>{run.status.replace("_", " ")}</span>}
        </p>
      </div>
      <div className="head-actions">
        <a href={run.html_url} target="_blank" rel="noreferrer noopener">
          Open on GitHub
        </a>
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
}

function Evidence({ graph }: { graph: NonNullable<ReturnType<typeof graphFor>> }) {
  const e = graph.evidence;
  return (
    <div className={`evidence ${e.kind}`} data-testid="graph-evidence" role="note">
      {e.kind === "workflow-file" ? (
        <p>
          Dependencies from <code>{e.path}</code> at {shortSha(e.revision)} (the run's commit) · {e.matchedJobs} of {e.totalJobs} jobs matched.
        </p>
      ) : (
        <p>
          <strong>Dependencies unavailable.</strong> {e.reason} Jobs are shown without dependency edges.
        </p>
      )}
      {e.notes.length > 0 && (
        <ul>
          {e.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FailureOverview({ graph, onSelect }: { graph: NonNullable<ReturnType<typeof graphFor>>; onSelect(node: GraphNode): void }) {
  const failing = graph.nodes.filter((n) => n.status === "failure" || n.status === "timed_out" || n.status === "cancelled");
  const running = graph.nodes.filter((n) => n.status === "in_progress" || n.status === "queued" || n.status === "waiting");
  return (
    <section className="panel details" aria-labelledby="overview-heading">
      <h3 id="overview-heading">{failing.length ? "Where this run failed" : running.length ? "Still running or waiting" : "Run summary"}</h3>
      {failing.length === 0 && running.length === 0 && <p className="note">No failed, cancelled or running jobs. Select any job to see its steps and log.</p>}
      <ul className="overview-list">
        {[...failing, ...running].map((n) => (
          <li key={n.key}>
            <button className="linklike" onClick={() => onSelect(n)}>
              <StatusIcon status={n.status} /> {n.label}
            </button>{" "}
            <span className="muted">{n.members.length > 1 ? `${n.members.length} jobs` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
