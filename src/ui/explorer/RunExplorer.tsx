// A run's detail view, in three levels:
//   1. release overview: the run's phases (from its environments or a phase file) at a glance, and why it stopped;
//   2. phase detail: one phase's jobs and real dependencies (and a reusable call as its own context);
//   3. job detail: steps, custom actions and the log.
// The raw execution graph is always available as a second view, and is the only view when jobs cannot be
// grouped confidently. Data is fetched on demand; the URL keeps the view, phase, job, log and run attempt.
//
// Run attempts: the latest attempt is the default. An earlier attempt is loaded from GitHub's attempt endpoints
// (`…/runs/{id}/attempts/{n}` and `…/attempts/{n}/jobs`), and every view below (graph, overview, timeline, stats,
// job details, logs) is built from that attempt's jobs only. Nothing falls back to another attempt's data.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import type { Environment } from "../../app/environment";
import { calledWorkflowGraph, durationMs, type GraphNode } from "../../domain/graph/build";
import { treeAt } from "../../domain/graph/hierarchy";
import { layoutGraph } from "../../domain/graph/layout";
import { deploymentsOf } from "../../domain/insights/deployments";
import { analyzeImpact } from "../../domain/insights/impact";
import { buildSourceTree } from "../../domain/insights/source";
import { computeRunStats } from "../../domain/insights/stats";
import { buildTimeline } from "../../domain/insights/timeline";
import { buildOverview, gatesFor, type ReleaseOverview as Overview } from "../../domain/phases/phases";
import { routeToHash, type Route } from "../../domain/run-url";
import type { Job, Run, RunRef } from "../../domain/types";
import { GalleryStrip } from "../../fixture-mode/gallery";
import { AttemptMismatchError } from "../../github/client";
import { loadGateEvidence, loadPhaseManifest } from "../../runs/release";
import { graphFor, loadWorkflowDefinition, rootFile } from "../../runs/workflow-graph";
import { loadWorkflowTree } from "../../runs/workflow-tree";
import { absoluteTime, firstLine, formatDuration, relativeTime, shortSha } from "../format";
import { LogPanel } from "../LogPanel";
import { ErrorState } from "../RepoDashboard";
import { StatusBadge, StatusIcon, statusOf } from "../status";
import { FailureImpact, impactFocus } from "./FailureImpact";
import { GraphCanvas, nodeHeight } from "./GraphCanvas";
import { JobDetails } from "./JobDetails";
import { JobList } from "./JobList";
import { RunCompare } from "./RunCompare";
import { RunArtifacts } from "./RunArtifacts";
import { RunDeployments } from "./RunDeployments";
import { RunHistory } from "./RunHistory";
import { RunSearch } from "./RunSearch";
import { PhaseDetail } from "./PhaseDetail";
import { ReleaseOverview } from "./ReleaseOverview";
import { RunStats } from "./RunStats";
import { SourceExplorer } from "./SourceExplorer";
import { Timeline } from "./Timeline";

type Props = { env: Environment; run: RunRef; route: Route };

const VIEW_NAME = { overview: "Release overview", graph: "Execution graph", timeline: "Timeline", source: "Workflow source", compare: "Comparison", search: "Search", history: "History" } as const;

export function RunExplorer({ env, run: ref, route }: Props) {
  const { jobId, log, line, step, attempt } = route;
  const key = [env.mode, ref.owner, ref.repo, ref.runId];
  // The run as GitHub reports it now (its latest attempt): the run's identity and how many attempts it has.
  const latest = useQuery({ queryKey: ["run", ...key], queryFn: () => env.client.getRun(ref) });
  const attemptRun = useQuery({ ...attemptQuery(env, ref, attempt ?? 0), enabled: attempt !== undefined });
  const run = attempt === undefined ? latest : attemptRun;
  const jobs = useQuery({ queryKey: ["jobs", ...key, attempt ?? "latest"], queryFn: () => env.client.getJobs(ref, attempt) });
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
    // Per attempt: GitHub reports the reusable-workflow revisions (`referenced_workflows`) on each attempt.
    queryKey: ["workflow-tree", ...key, attempt ?? "latest", run.data?.head_sha, run.data?.path],
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
  // Approval history is recorded per run, not per attempt, so it is used only for the latest attempt; an earlier
  // attempt's gates come from its own job statuses.
  const gateEvidence = useQuery({
    queryKey: ["gates", ...key, anyWaiting],
    queryFn: () => loadGateEvidence(env.client, ref, anyWaiting),
    enabled: hasEnvironments && jobs.isSuccess && attempt === undefined,
    staleTime: 60_000,
  });
  const layout = useMemo(() => (graph ? layoutGraph(graph.nodes.map((n) => ({ key: n.key, height: nodeHeight(n) })), graph.edges) : null), [graph]);

  const releaseLoading = Boolean(def) && (manifest.isPending || (hasEnvironments && attempt === undefined && gateEvidence.isPending));
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
    // Jobs in no phase are framed together and labelled, never drawn as if part of a neighbouring phase.
    for (const k of release.unassignedKeys) m.set(k, "Other jobs");
    return m;
  }, [release]);
  const view: "overview" | "graph" | "timeline" | "source" | "compare" | "search" | "history" = route.view ?? (overview && !release ? "graph" : "overview");

  // Run insights: statistics (available as soon as jobs load; the critical path needs the graph), the timeline
  // and the workflow source tree, all from data already loaded for the run.
  const stats = useMemo(() => (jobs.data ? computeRunStats(jobs.data, graph) : null), [jobs.data, graph]);
  // Failure impact: from the graph of this attempt only (its jobs and the workflow file's needs).
  const impact = useMemo(() => (graph ? analyzeImpact(graph, run.data) : null), [graph, run.data]);
  const impactShown = view === "graph" && route.impact && impact ? (impact.failures.some((f) => f.key === route.impact) ? route.impact : "all") : undefined;
  const focus = useMemo(() => (impact && impactShown ? impactFocus(impact, impactShown) : undefined), [impact, impactShown]);
  const deployments = useMemo(() => (graph && run.data ? deploymentsOf(run.data, graph, release) : undefined), [graph, run.data, release]);
  const timeline = useMemo(() => (jobs.data && view === "timeline" ? buildTimeline(jobs.data, graph, release?.phases) : null), [jobs.data, graph, release, view]);
  const source = useMemo(() => {
    if (view !== "source" || !run.data || definition.isPending || treePending) return null;
    const result = definition.data;
    if (!result || !("definition" in result))
      return buildSourceTree({ definition: null, unavailable: result?.unavailableReason ?? "The workflow file could not be loaded.", calls: new Map() }, graph);
    return buildSourceTree(hierarchy.data?.tree ?? { file: rootFile(ref, run.data, result), definition: result.definition, calls: new Map() }, graph);
  }, [view, run.data, definition.data, definition.isPending, treePending, hierarchy.data, graph, ref]);

  const selectedJob = jobs.data?.find((j) => j.id === jobId);
  const selectedNode = graph?.nodes.find((n) => (selectedJob ? n.members.some((m) => m.job.id === selectedJob.id) : n.key === nodeKey));
  // A job inside a call shown as one node: its steps are defined in the called workflow (from the loaded hierarchy).
  const callTree = selectedNode?.kind === "reusable" && selectedNode.callId && hierarchy.data ? treeAt(hierarchy.data.tree, selectedNode.callId) : undefined;
  const phaseOfNode = (k?: string) => (k && release ? (release.nodePhase.get(k) ?? (release.unassignedKeys.includes(k) ? "other" : undefined)) : undefined);
  const activePhase = view === "overview" ? (route.phase ?? phaseOfNode(selectedNode?.key)) : undefined;

  const go = (next: Partial<Route>) => {
    window.location.hash = routeToHash({ run: ref, view: route.view, phase: route.phase, attempt, impact: route.impact, base: route.base, q: route.q, ...next });
  };
  // Another attempt has other jobs (other ids, logs and results): keep only the view (and that impact is shown).
  const selectAttempt = (n: number) =>
    go({
      attempt: n === latest.data?.run_attempt ? undefined : n,
      phase: undefined,
      call: undefined,
      jobId: undefined,
      log: undefined,
      step: undefined,
      line: undefined,
      impact: route.impact ? "all" : undefined,
    });
  // The open log's place (step and line), kept when switching views so the user does not lose it.
  const logPlace = selectedJob && log ? { log, step, line } : {};
  // A link into the selected job's log that keeps the run, view, phase and call.
  const placeHref = (place: { step?: number; line?: number }) =>
    routeToHash({ run: ref, view: route.view, phase: activePhase, call: route.call, jobId: selectedJob?.id, log: true, attempt, impact: route.impact, base: route.base, q: route.q, ...place });
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
  const openImpact = () => go({ view: "graph", phase: undefined, call: undefined, impact: "all", jobId: selectedJob?.id, ...logPlace });
  const selectPhase = (id: string) => go({ phase: id === activePhase ? undefined : id, call: undefined, jobId: undefined, log: undefined });
  const refresh = () => {
    void latest.refetch();
    if (attempt !== undefined) void attemptRun.refetch();
    void jobs.refetch();
    void definition.refetch();
    void hierarchy.refetch();
    void manifest.refetch();
    void gateEvidence.refetch();
  };

  if (latest.isPending || (attempt !== undefined && attemptRun.isPending)) return <p className="state">{attempt === undefined ? "Loading run…" : `Loading attempt ${attempt}…`}</p>;
  if (latest.isError) return <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />;
  if (attemptRun.isError || (attempt !== undefined && attempt > latest.data.run_attempt)) {
    // Never fall back to another attempt's data: say what could not be loaded, and offer the attempts that exist.
    return (
      <div className="explorer">
        <div className="state state-error" role="alert" data-testid="attempt-error">
          <p>
            Attempt {attempt} of run #{latest.data.run_number ?? ref.runId} could not be loaded
            {attempt! > latest.data.run_attempt ? `: the run has ${latest.data.run_attempt} attempt${latest.data.run_attempt === 1 ? "" : "s"}.` : "."}
          </p>
          {attemptRun.isError && <ErrorState error={attemptRun.error} onRetry={() => void attemptRun.refetch()} />}
        </div>
        <AttemptPicker env={env} runRef={ref} latest={latest.data} selected={attempt!} onSelect={selectAttempt} />
      </div>
    );
  }
  const r = run.data!;
  const latestAttempt = latest.data.run_attempt;
  const shownAttempt = attempt ?? latestAttempt;
  // Jobs GitHub lists for this attempt but reports as run in another (e.g. kept from an earlier attempt when only
  // failed jobs were re-run). They are labelled, never silently mixed in.
  const carried = jobs.data?.filter((j) => j.run_attempt !== undefined && j.run_attempt !== shownAttempt) ?? [];
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
      <RunHeader
        run={r}
        runRef={ref}
        jobs={jobs.data}
        onRefresh={refresh}
        refreshing={run.isFetching || jobs.isFetching}
        htmlUrl={attempt === undefined ? r.html_url : `${latest.data.html_url}/attempts/${attempt}`}
        attempts={latestAttempt > 1 ? <AttemptPicker env={env} runRef={ref} latest={latest.data} selected={shownAttempt} onSelect={selectAttempt} /> : undefined}
      />
      {attempt !== undefined && attempt !== latestAttempt && (
        <div className="attempt-banner" role="status" data-testid="attempt-banner">
          <p>
            <strong>
              Viewing attempt {attempt} of {latestAttempt}
            </strong>{" "}
            (not the latest). The jobs, results, timings and logs below are from attempt {attempt} only. Deployment approval history is recorded per run, not
            per attempt, so it is shown only on the latest attempt.
          </p>
          <button type="button" onClick={() => selectAttempt(latestAttempt)}>
            Show the latest attempt ({latestAttempt})
          </button>
        </div>
      )}
      {carried.length > 0 && (
        <p className="note" data-testid="carried-jobs">
          GitHub lists {carried.length} job{carried.length === 1 ? "" : "s"} in attempt {shownAttempt} that it reports as run in an earlier attempt
          (not re-run): {carried.slice(0, 5).map((j) => `${j.name} (attempt ${j.run_attempt})`).join(", ")}
          {carried.length > 5 ? "…" : ""}.
        </p>
      )}
      {jobs.isSuccess && jobs.data.length > 0 && <RunStats stats={stats} deployments={deployments} graphPending={!graph} onSelectJob={(job) => selectJob(job)} />}

      <div className="view-switch" role="tablist" aria-label="Run views">
        <button
          role="tab"
          aria-selected={view === "overview"}
          disabled={!release}
          title={overview && "unavailable" in overview ? overview.unavailable : undefined}
          onClick={() => go({ view: undefined, phase: phaseOfNode(selectedNode?.key) ?? route.phase, jobId: selectedJob?.id, impact: undefined, base: undefined, q: undefined, ...logPlace })}
        >
          Release overview
        </button>
        <button role="tab" aria-selected={view === "graph"} onClick={() => go({ view: "graph", phase: undefined, call: undefined, jobId: selectedJob?.id, base: undefined, q: undefined, ...logPlace })}>
          Execution graph (all jobs)
        </button>
        <button role="tab" aria-selected={view === "timeline"} onClick={() => go({ view: "timeline", phase: undefined, call: undefined, jobId: selectedJob?.id, impact: undefined, base: undefined, q: undefined, ...logPlace })}>
          Timeline
        </button>
        <button role="tab" aria-selected={view === "source"} onClick={() => go({ view: "source", phase: undefined, call: undefined, jobId: selectedJob?.id, impact: undefined, base: undefined, q: undefined, ...logPlace })}>
          Workflow source
        </button>
        <button role="tab" aria-selected={view === "compare"} onClick={() => go({ view: "compare", phase: undefined, call: undefined, jobId: selectedJob?.id, impact: undefined, q: undefined, ...logPlace })}>
          Compare
        </button>
        <button role="tab" aria-selected={view === "search"} onClick={() => go({ view: "search", phase: undefined, call: undefined, jobId: selectedJob?.id, impact: undefined, base: undefined, ...logPlace })}>
          Search
        </button>
        <button role="tab" aria-selected={view === "history"} onClick={() => go({ view: "history", phase: undefined, call: undefined, jobId: selectedJob?.id, impact: undefined, base: undefined, q: undefined, ...logPlace })}>
          History
        </button>
        {impact && impact.failures.length > 0 && !impactShown && (
          <button type="button" className="investigate" onClick={openImpact} data-testid="investigate-failure">
            Investigate failure
          </button>
        )}
        {overview && "unavailable" in overview && (
          <span className="muted" data-testid="overview-unavailable">
            Release overview unavailable: {overview.unavailable}
          </span>
        )}
      </div>

      <section className="panel graph-panel" aria-label={VIEW_NAME[view]} id="graph">
        {view === "compare" ? (
          <RunCompare
            env={env}
            runRef={ref}
            latest={latest.data}
            attempt={shownAttempt}
            routeAttempt={attempt}
            base={route.base}
            onSelectBase={(b) => go({ base: b, jobId: undefined, log: undefined, step: undefined, line: undefined })}
            onSelectJob={(job) => selectJob(job)}
            graphHref={(jobId) => routeToHash({ run: ref, view: "graph", attempt, jobId })}
            stepHref={(job, n) => routeToHash({ run: ref, view: "compare", attempt, base: route.base, jobId: job.id, step: n })}
          />
        ) : view === "history" && !jobs.isError ? (
          run.data && jobs.isSuccess ? (
            <RunHistory env={env} runRef={ref} run={run.data} attempt={shownAttempt} jobs={jobs.data} />
          ) : (
            <p className="state">Loading this run…</p>
          )
        ) : view === "search" && jobs.isSuccess ? (
          <RunSearch
            env={env}
            runRef={ref}
            attemptKey={`${ref.owner}/${ref.repo}/${ref.runId}/${shownAttempt}`}
            jobs={jobs.data}
            graph={graph}
            impact={impact}
            query={route.q ?? ""}
            onQuery={(q) => go({ q })}
            links={{
              job: (jobId) => routeToHash({ run: ref, view: "search", attempt, q: route.q, jobId }),
              step: (job, n) => routeToHash({ run: ref, view: "search", attempt, q: route.q, jobId: job.id, step: n }),
              line: (job, n) => routeToHash({ run: ref, view: "search", attempt, q: route.q, jobId: job.id, line: n }),
              log: (job) => routeToHash({ run: ref, view: "search", attempt, q: route.q, jobId: job.id, log: true }),
            }}
          />
        ) : view === "timeline" && jobs.isSuccess && timeline && jobs.data.length > 0 ? (
          <>
            <header className="panel-head">
              <h3>Timeline</h3>
              {loadingState && <span className="muted">{loadingState} Grouping and dependencies appear when it is done.</span>}
            </header>
            <Timeline model={timeline} selectedJobId={selectedJob?.id} onSelectJob={(job) => selectJob(job)} />
          </>
        ) : view === "source" && source ? (
          <>
            <header className="panel-head">
              <h3>Workflow source</h3>
            </header>
            <SourceExplorer
              root={source}
              onShowNode={(k) => {
                const n = graph?.nodes.find((x) => x.key === k);
                if (n) selectNode(n);
                window.setTimeout(() => document.getElementById("job-details")?.scrollIntoView({ block: "start" }), 50);
              }}
            />
          </>
        ) : loadingState ? (
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
                <Evidence graph={graph} inProgress={r.status !== "completed"} />
              </header>
              {impact && impactShown && (
                <FailureImpact
                  impact={impact}
                  graph={graph}
                  selected={impactShown}
                  selectedJobId={selectedJob?.id}
                  onSelect={(k) => go({ impact: k })}
                  onClose={() => go({ impact: undefined })}
                  onSelectNode={selectNode}
                  onSelectJob={(job) => selectJob(job)}
                  stepHref={(job, n) => routeToHash({ run: ref, view: route.view, jobId: job.id, step: n, attempt, impact: route.impact })}
                  compareHref={routeToHash({ run: ref, view: "compare", attempt })}
                  searchHref={routeToHash({ run: ref, view: "search", attempt })}
                />
              )}
              <GraphCanvas
                graph={graph}
                lanes={rawLanes}
                groups={rawColumns}
                selectedKey={selectedNode?.key}
                selectedJobId={selectedJob?.id}
                onSelectNode={selectNode}
                onSelectJob={(job) => selectJob(job)}
                annotations={release ? { roles: release.roles, gates: release.gates } : undefined}
                focus={focus}
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
            <FailureOverview graph={graph} onSelect={selectNode} onInvestigate={impact?.failures.length && !impactShown ? openImpact : undefined} />
          )}
        </div>
      )}

      {selectedJob && log && (
        <div className="log-wrap">
          <a href="#graph" className="back-to-graph" onClick={(e) => (e.preventDefault(), document.getElementById("graph")?.scrollIntoView())}>
            ↑ Back to the {VIEW_NAME[view].toLowerCase()}
          </a>
          <LogPanel env={env} jobRef={{ ...ref, jobId: selectedJob.id }} job={selectedJob} line={line} step={step} links={logLinks} highlight={view === "search" ? route.q : undefined} />
        </div>
      )}
      {jobId !== undefined && jobs.isSuccess && !selectedJob && (
        <p className="state state-error">
          Job {jobId} is not part of {attempt === undefined ? "this run's latest attempt" : `attempt ${attempt} of this run`}
          {latestAttempt > 1 ? "; it may belong to another attempt (choose one above)." : "."}
        </p>
      )}
      {run.data && <RunDeployments key={run.data.id} env={env} runRef={ref} run={run.data} records={deployments} jobs={jobs.data} />}
      {/* The latest run data, not the attempt on screen, decides the attempt wording; the attempt is passed separately. */}
      <RunArtifacts key={`${ref.owner}/${ref.repo}/${latest.data.id}`} env={env} runRef={ref} latest={latest.data} viewedAttempt={attempt} />
    </div>
  );
}

/** One attempt of the run, cached per attempt (a finished attempt does not change). */
function attemptQuery(env: Environment, ref: RunRef, n: number) {
  return {
    queryKey: ["run", env.mode, ref.owner, ref.repo, ref.runId, "attempt", n],
    queryFn: async () => {
      const r = await env.client.getRun(ref, n);
      if (r.run_attempt !== n) throw new AttemptMismatchError(n, r.run_attempt);
      return r;
    },
    staleTime: 60_000,
  };
}

/** Status of each attempt (fetched for the 10 most recent), and a way to switch. Shown only with several attempts. */
function AttemptPicker({ env, runRef, latest, selected, onSelect }: { env: Environment; runRef: RunRef; latest: Run; selected: number; onSelect(n: number): void }) {
  const count = latest.run_attempt;
  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  const earlier = useQueries({ queries: numbers.slice(0, -1).map((n) => ({ ...attemptQuery(env, runRef, n), enabled: n > count - 10 })) });
  return (
    <nav className="attempts" aria-label="Run attempts" data-testid="attempts">
      <span className="muted">Attempts:</span>
      {numbers.map((n, i) => {
        const data = n === count ? latest : earlier[i]?.data;
        const failed = n !== count && earlier[i]?.isError;
        return (
          <button
            key={n}
            type="button"
            className={`attempt${n === selected ? " selected" : ""}`}
            aria-current={n === selected ? "true" : undefined}
            onClick={() => onSelect(n)}
            data-testid="attempt"
            data-attempt={n}
            data-status={data ? statusOf(data) : undefined}
            title={failed ? "This attempt's status could not be loaded." : undefined}
          >
            {data ? <StatusIcon status={statusOf(data)} /> : null} Attempt {n}
            {n === count ? " · latest" : ""}
          </button>
        );
      })}
    </nav>
  );
}

function RunHeader({
  run,
  runRef,
  jobs,
  onRefresh,
  refreshing,
  htmlUrl,
  attempts,
}: {
  run: Run;
  runRef: RunRef;
  jobs?: Job[];
  onRefresh(): void;
  refreshing: boolean;
  htmlUrl: string;
  attempts?: ReactNode;
}) {
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
        {attempts}
      </div>
      <div className="head-actions">
        <a href={htmlUrl} target="_blank" rel="noreferrer noopener">
          Open on GitHub
        </a>
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
}

function Evidence({ graph, inProgress }: { graph: NonNullable<ReturnType<typeof graphFor>>; inProgress: boolean }) {
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
      {graph.declared?.length ? (
        <details className="declared-context" data-testid="declared-context">
          <summary>
            Declared in the workflow files, with no job in this run: {graph.declared.length} (definition context only; not drawn as jobs
            {inProgress ? ". The run is still in progress: GitHub may not have created them yet" : ""})
          </summary>
          <ul>
            {graph.declared.map((d) => (
              <li key={d.key} data-key={d.key}>
                <code>{[...(d.context?.labels ?? []), d.label].join(" › ")}</code>
                {d.uses && <span className="muted"> · calls {d.uses}</span>}
                {d.needs.length > 0 && <span className="muted"> · needs {d.needs.join(", ")}</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function FailureOverview({ graph, onSelect, onInvestigate }: { graph: NonNullable<ReturnType<typeof graphFor>>; onSelect(node: GraphNode): void; onInvestigate?(): void }) {
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
      {onInvestigate && (
        <button type="button" onClick={onInvestigate}>
          Investigate failure impact
        </button>
      )}
    </section>
  );
}
