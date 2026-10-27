// Investigation report (SYNTHETIC repository, runs, jobs and evidence).
import { describe, expect, it } from "vitest";
import type { RunComparison } from "../compare/runs";
import { artifactEvidence } from "../insights/artifacts";
import type { Impact } from "../insights/impact";
import { releaseEvidence } from "../insights/release-evidence";
import type { Job, Run } from "../types";
import { buildReport, checkExcerpt, checkExcerptSize, type ComparisonFindings, EXCERPT_WARNING, maskCredentials, NO_CAUSE_NOTE, NO_EXCERPTS_NOTE, REPORT_LIMITS, reportFilename, REPORT_SCHEMA, REPORT_VERSION, validateReport, type ReportInput } from "./report";

const C = "c".repeat(40);
const repo = { owner: "acme-synthetic", repo: "app" };
const HTML = "https://github.com/acme-synthetic/app/actions/runs/500";
const run = (extra: Partial<Run> = {}): Run => ({
  id: 500,
  name: "CI",
  display_title: "[synthetic] Fix the build",
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
  head_branch: "main",
  head_sha: C,
  html_url: HTML,
  event: "push",
  path: ".github/workflows/ci.yml",
  run_number: 42,
  created_at: "2026-10-20T10:00:00Z",
  run_started_at: "2026-10-20T10:00:05Z",
  updated_at: "2026-10-20T10:09:00Z",
  ...extra,
});
const job = (id: number, name: string, conclusion: string | null, extra: Partial<Job> = {}): Job => ({
  id,
  name,
  status: "completed",
  conclusion,
  started_at: "2026-10-20T10:01:00Z",
  completed_at: "2026-10-20T10:05:00Z",
  html_url: `${HTML}/job/${id}?pr=1#step:3:1`,
  run_attempt: 1,
  steps: [
    { number: 1, name: "Checkout", status: "completed", conclusion: "success", started_at: null, completed_at: null },
    { number: 3, name: "Run tests", status: "completed", conclusion, started_at: null, completed_at: null },
  ],
  ...extra,
});
const jobs = [job(1, "build", "success"), job(2, "test", "failure"), job(3, "deploy", "skipped")];
const impact: Impact = {
  failures: [{ key: "test", label: "test", status: "failure", kind: "failure", jobs: [], upstream: ["build"], failedUpstream: [], downstream: [{ key: "deploy", reason: "blocked", via: ["test"] }], declaredDownstream: [], edges: ["build->test", "test->deploy"], untraced: false }],
  earliest: { key: "test", job: jobs[1]!, at: "2026-10-20T10:05:00Z", tied: [] },
  dependencies: "workflow-file",
  unrelatedSkipped: [],
  notes: [],
};
const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  mode: "live",
  repo,
  latest: run(),
  jobs: { state: "loaded", value: jobs },
  impact: { state: "loaded", value: impact },
  deployments: { state: "not loaded" },
  releases: { state: "not loaded" },
  artifacts: { state: "not loaded" },
  generatedAt: "2026-10-26T12:00:00Z",
  ...over,
});

describe("investigation report", () => {
  it("records the run's identity, versioned schema and GitHub links without query or fragment", () => {
    const r = buildReport(base());
    expect(r).toMatchObject({ schema: REPORT_SCHEMA, version: REPORT_VERSION, source: { mode: "live", host: "github.com", synthetic: false } });
    expect(r.repository).toEqual({ owner: "acme-synthetic", repo: "app", url: "https://github.com/acme-synthetic/app" });
    expect(r.run).toMatchObject({ id: 500, number: 42, commit: C, branch: "main", conclusion: "failure", workflowPath: ".github/workflows/ci.yml", url: HTML, latestAttempt: 1, viewedAttempt: 1 });
    expect(r.run.attemptNote).toBe("The run had one attempt when the report was made.");
    expect(r.failures.state).toBe("included");
    expect(r.failures.data!.jobs).toEqual([
      { id: 2, name: "test", conclusion: "failure", attempt: 1, step: { number: 3, name: "Run tests", conclusion: "failure" }, completedAt: "2026-10-20T10:05:00Z", url: `${HTML}/job/2` },
    ]);
    expect(r.caveats[0]).toBe(NO_CAUSE_NOTE);
    expect(validateReport(r)).toEqual({ ok: true, errors: [] });
  });

  it("reports impact findings as GitHub's data shows them; 'completed first' is never called the cause", () => {
    const r = buildReport(base());
    expect(r.failures.data!.impact).toMatchObject({ dependencies: "workflow-file", completedFirst: { job: "test", at: "2026-10-20T10:05:00Z" }, failures: [{ key: "test", downstream: [{ key: "deploy", reason: "blocked" }] }] });
    expect(r.caveats).toContain("\"Completed first\" is the order of GitHub's timestamps, not evidence of which failure caused the others.");
    expect(JSON.stringify(r)).not.toMatch(/root cause|caused by|proven/i);
  });

  it("unloaded, unavailable and not applicable sections are explicit, never empty lists", () => {
    const r = buildReport(base({ jobs: { state: "unavailable", reason: "GitHub request failed: rate-limited" }, impact: { state: "not loaded" } }));
    expect(r.failures).toEqual({ state: "unavailable", reason: "GitHub request failed: rate-limited" });
    for (const s of [r.comparison, r.deployments, r.releases, r.artifacts]) expect(s).toEqual({ state: "not loaded" });
    expect(r.logExcerpts).toEqual({ state: "not applicable", reason: NO_EXCERPTS_NOTE });
    expect(NO_EXCERPTS_NOTE).toMatch(/does not mean the logs hold no relevant lines/);
    expect(validateReport(r).ok).toBe(true);
  });

  it("incomplete evidence is partial, with what is missing", () => {
    const noDeps = buildReport(base({ impact: { state: "loaded", value: { ...impact, dependencies: "unavailable" } } }));
    expect(noDeps.failures).toMatchObject({ state: "partial", missing: ["The workflow file's dependencies were unavailable, so downstream impact is not traced."] });
    const noImpact = buildReport(base({ impact: { state: "not loaded" } }));
    expect(noImpact.failures).toMatchObject({ state: "partial", missing: ["Failure impact was not analysed."] });
    expect(noImpact.failures.data!.impact).toBeUndefined();

    const listing = { items: [{ id: 1, name: "dist", size_in_bytes: 1, expired: false, workflow_run: { id: 500, head_sha: C } }], totalCount: 250, morePages: true };
    const a = buildReport(base({ artifacts: { state: "loaded", value: artifactEvidence({ run: run(), listing }) } }));
    expect(a.artifacts).toMatchObject({ state: "partial", missing: ["1 of 250 listed artifacts were read."], data: { listing: "incomplete", read: 1, totalCount: 250 } });

    // A complete listing longer than the report's limit is partial too, never silently cut.
    const many = { items: Array.from({ length: 104 }, (_, i) => ({ id: i + 1, name: `shard-${i}`, size_in_bytes: 1, expired: false, workflow_run: { id: 500, head_sha: C } })), totalCount: 104, morePages: false };
    const cut = buildReport(base({ artifacts: { state: "loaded", value: artifactEvidence({ run: run(), listing: many }) } }));
    expect(cut.artifacts).toMatchObject({ state: "partial", missing: ["Only the first 100 of 104 artifacts are included."], data: { listing: "complete", read: 104 } });
    expect(cut.artifacts.data!.items).toHaveLength(REPORT_LIMITS.items);

    const failedStatuses = releaseEvidence({ repo, run: run(), deployments: [{ deployment: { id: 7, sha: C, environment: "env-a" }, statuses: null }] });
    const d = buildReport(base({ deployments: { state: "loaded", value: failedStatuses, missing: ["The statuses of 1 deployment could not be loaded."] } }));
    expect(d.deployments).toMatchObject({ state: "partial", missing: ["The statuses of 1 deployment could not be loaded."], data: { items: [{ id: 7, association: "same commit", outcome: "statuses not loaded" }] } });
    expect(d.caveats).toContain("A shared commit does not establish that a release was deployed or that an artifact was published or used.");
    expect(validateReport(d).ok).toBe(true);
  });

  it("an earlier attempt: its own jobs and results, the latest run's identity, and per-run evidence never attributed to it", () => {
    const latest = run({ run_attempt: 2, conclusion: "success" });
    const attempt1 = run({ run_attempt: 1, conclusion: "failure", updated_at: "2026-10-20T10:04:00Z" });
    const listing = { items: [{ id: 1, name: "dist", size_in_bytes: 1, expired: false, workflow_run: { id: 500, head_sha: C } }], totalCount: 1, morePages: false };
    const r = buildReport(base({ latest, viewedAttempt: { number: 1, run: attempt1 }, artifacts: { state: "loaded", value: artifactEvidence({ run: latest, viewedAttempt: 1, listing }) } }));
    expect(r.run).toMatchObject({ latestAttempt: 2, viewedAttempt: 1, conclusion: "failure", updatedAt: "2026-10-20T10:04:00Z", url: `${HTML}/attempts/1` });
    expect(r.run.attemptNote).toBe("Attempt 1 of 2 (not the latest). Jobs, failures and log excerpts are from attempt 1; deployments, releases and artifacts are recorded per run or commit, not per attempt.");
    expect(r.artifacts.data).toMatchObject({ attempt: "whole run" });
    expect(r.artifacts.data!.notes).toContain("You are viewing attempt 1 of 2; these artifacts are not shown as belonging to it.");
    expect(JSON.stringify(r)).not.toContain("single attempt");
    const latestView = buildReport(base({ latest }));
    expect(latestView.run.attemptNote).toBe("Attempt 2, the latest of 2. Deployments, releases and artifacts are recorded per run or commit, not per attempt.");
  });

  it("a comparison keeps only findings: no workflow text or diff", () => {
    const comparison = {
      sameExecution: false,
      comparable: { ok: true, reasons: [] },
      conclusion: { base: "success", head: "failure", changed: true },
      duration: { comparable: true },
      jobs: [
        { key: "build", label: "build", basis: "workflow-file", change: "same", duration: { comparable: true }, steps: [], notes: [] },
        { key: "test", label: "test", basis: "workflow-file", change: "outcome", baseStatus: "success", headStatus: "failure", duration: { comparable: true }, steps: [], notes: [] },
      ],
      counts: { outcome: 1, added: 0, removed: 0, slower: 0, faster: 0, nowFailing: 1, nowPassing: 0 },
      graph: { available: true, addedJobs: [], removedJobs: [], addedEdges: [], removedEdges: [] },
      workflow: { samePath: true, sameCommit: false, file: "changed", diff: { secretWorkflowLine: "run: deploy --key=abc" }, called: [] },
      environments: [],
      notes: [],
      summary: ["test now fails."],
    } as unknown as RunComparison;
    // The real comparison type is accepted as is.
    const findings: ComparisonFindings = comparison;
    expect(findings).toBe(comparison);
    const r = buildReport(base({ comparison: { state: "loaded", value: { base: run({ id: 499, conclusion: "success", html_url: "https://github.com/acme-synthetic/app/actions/runs/499" }), baseAttempt: 1, comparison } } }));
    expect(r.comparison.data).toMatchObject({ base: { id: 499, attempt: 1, url: "https://github.com/acme-synthetic/app/actions/runs/499" }, conclusionChanged: true, workflowFile: "changed", changedJobs: [{ key: "test", change: "outcome", baseStatus: "success", headStatus: "failure" }] });
    expect(JSON.stringify(r)).not.toContain("deploy --key");
  });
});

describe("privacy", () => {
  it("includes only selected excerpts, bounded, credential-shaped text masked, with the warning", () => {
    const lines = ["Run tests", "Authorization: Bearer abcdefghijklmnop1234", "using ghp_" + "a".repeat(36), "password=hunter2-synthetic", "fetch https://user:pa55@example.test/x", "x".repeat(REPORT_LIMITS.charsPerLine + 5), ...Array.from({ length: 300 }, (_, i) => `line ${i}`)];
    const r = buildReport(base({ excerpts: [{ jobId: 2, stepNumber: 3, startLine: 10, lines }] }));
    const e = r.logExcerpts.data!.excerpts[0]!;
    expect(r.logExcerpts.state).toBe("partial");
    expect(r.logExcerpts.data!.warning).toBe(EXCERPT_WARNING);
    expect(e).toMatchObject({ jobId: 2, job: "test", step: 3, startLine: 10, endLine: 10 + REPORT_LIMITS.linesPerExcerpt - 1, truncated: true, masked: 4 });
    expect(e.lines).toHaveLength(REPORT_LIMITS.linesPerExcerpt);
    expect(e.lines.slice(1, 5)).toEqual(["Authorization: Bearer [masked]", "using [masked]", "password=[masked]", "fetch https://[masked]@example.test/x"]);
    expect(e.lines[5]!.length).toBe(REPORT_LIMITS.charsPerLine + 1);
    expect(r.privacy).toEqual({ tokens: false, fullLogs: false, workflowSource: false, rawResponses: false, downloadUrls: false, excerpts: 1 });
    expect(validateReport(r)).toEqual({ ok: true, errors: [] });
  });

  it("caps the number of excerpts", () => {
    const r = buildReport(base({ excerpts: Array.from({ length: 12 }, (_, i) => ({ jobId: 2, startLine: i * 10 + 1, lines: ["x"] })) }));
    expect(r.logExcerpts.data!.excerpts).toHaveLength(REPORT_LIMITS.excerpts);
    expect(r.logExcerpts.missing).toEqual(["Only the first 10 of 12 selected excerpts are included."]);
  });

  it("drops links to other hosts or with credentials, and never carries artifact download URLs", () => {
    const r = buildReport(
      base({
        jobs: { state: "loaded", value: [job(2, "test", "failure", { html_url: "https://evil.example.test/acme-synthetic/app/actions/runs/500/job/2" }), job(4, "lint", "failure", { html_url: "https://user:pw@github.com/x" })] },
        artifacts: { state: "loaded", value: artifactEvidence({ run: run(), listing: { items: [{ id: 1, name: "dist", size_in_bytes: 1, expired: true, archive_download_url: "https://api.github.com/zip", workflow_run: null }], totalCount: 1, morePages: false } }) },
      }),
    );
    expect(r.failures.data!.jobs.map((j) => j.url)).toEqual([undefined, undefined]);
    expect(JSON.stringify(r)).not.toMatch(/archive_download_url|\/zip|evil\.example/);
    expect(r.artifacts.data!.items[0]).toMatchObject({ expired: true, association: "unknown" });
  });

  it("refuses a selection over a limit instead of cutting it, and names lines that would be cut", () => {
    expect(checkExcerpt(["a", "b"], 0)).toEqual({ longLines: [] });
    expect(checkExcerpt([], 0).error).toBe("Select at least one line.");
    expect(checkExcerpt(Array.from({ length: 201 }, () => "x"), 0).error).toBe("The selection has 201 lines; an excerpt can hold at most 200. Shorten it.");
    expect(checkExcerpt(Array.from({ length: 200 }, () => "x"), 0).error).toBeUndefined();
    expect(checkExcerpt(["x"], REPORT_LIMITS.excerpts).error).toBe("The report already holds 10 excerpts, the most it can; remove one first.");
    expect(checkExcerpt(["ok", "y".repeat(2001), "z".repeat(2000)], 0)).toEqual({ longLines: [1] });
    expect(checkExcerptSize(212, 0)).toBe("The selection has 212 lines; an excerpt can hold at most 200. Shorten it.");
    expect(checkExcerptSize(1, 9)).toBeUndefined();
    // What buildReport then includes for that line: cut exactly at the limit, marked, and the excerpt flagged.
    const r = buildReport(base({ excerpts: [{ jobId: 2, startLine: 5, lines: ["ok", "y".repeat(2001)] }] }));
    const e = r.logExcerpts.data!.excerpts[0]!;
    expect(e.lines[1]).toBe(`${"y".repeat(2000)}…`);
    expect(e).toMatchObject({ startLine: 5, endLine: 6, truncated: true });
    expect(r.logExcerpts.state).toBe("partial");
  });

  it("removing an excerpt from the input removes it from the report", () => {
    const two = [{ jobId: 2, stepNumber: 3, startLine: 1, lines: ["excerpt-alpha"] }, { jobId: 2, stepNumber: 3, startLine: 9, lines: ["excerpt-beta"] }];
    expect(buildReport(base({ excerpts: two })).logExcerpts.data!.excerpts.map((e) => e.lines)).toEqual([["excerpt-alpha"], ["excerpt-beta"]]);
    const one = buildReport(base({ excerpts: two.slice(1) }));
    expect(one.logExcerpts.data!.excerpts.map((e) => e.startLine)).toEqual([9]);
    expect(JSON.stringify(one)).not.toContain("excerpt-alpha");
    expect(buildReport(base({ excerpts: [] })).logExcerpts.state).toBe("not applicable");
  });

  it("masks nothing in ordinary log lines", () => {
    expect(maskCredentials("npm ERR! Test failed: expected 2, got 3")).toEqual({ text: "npm ERR! Test failed: expected 2, got 3", masked: 0 });
  });

  it("fixture mode is marked synthetic", () => {
    const r = buildReport(base({ mode: "fixtures" }));
    expect(r.source.synthetic).toBe(true);
    expect(r.caveats).toContain("Made in fixture mode: the data is synthetic or a pinned fixture, not live GitHub data.");
  });
});

describe("validation", () => {
  it("rejects unknown schemas and versions, missing identity, inconsistent sections, forbidden fields and credentials", () => {
    const good = buildReport(base());
    expect(validateReport(null)).toEqual({ ok: false, errors: ["The report is not an object."] });
    expect(validateReport({ ...good, version: 2 }).errors).toContain("Unsupported version 2; this reader understands version 1.");
    expect(validateReport({ ...good, schema: "other" }).errors).toContain(`Unknown schema: expected ${REPORT_SCHEMA}.`);
    expect(validateReport({ ...good, run: { ...good.run, id: "500" } }).errors).toContain("The run identity is incomplete.");
    expect(validateReport({ ...good, releases: { state: "loaded" } }).errors).toContain("Section releases has no valid state.");
    expect(validateReport({ ...good, releases: { state: "included" } }).errors).toContain("Section releases is included but has no data.");
    expect(validateReport({ ...good, releases: { state: "not loaded", data: {} } }).errors).toContain("Section releases is not loaded but carries data.");
    expect(validateReport({ ...good, extra: { authorization: "x" } }).errors).toContain("Forbidden field report.extra.authorization.");
    expect(validateReport({ ...good, extra: { workflowText: "jobs: {}" } }).errors).toContain("Forbidden field report.extra.workflowText.");
    expect(validateReport({ ...good, run: { ...good.run, title: "leak ghp_" + "b".repeat(36) } }).errors).toContain("Credential-shaped text at report.run.title.");
    const withExcerpt = buildReport(base({ excerpts: [{ jobId: 2, startLine: 1, lines: ["x"] }] }));
    expect(validateReport({ ...withExcerpt, logExcerpts: { ...withExcerpt.logExcerpts, data: { ...withExcerpt.logExcerpts.data, warning: "" } } }).errors).toContain("Log excerpts are present without the sensitivity warning.");
  });

  it("a report survives a JSON round trip unchanged and still validates", () => {
    const r = buildReport(base({ excerpts: [{ jobId: 2, startLine: 1, lines: ["error: synthetic"] }] }));
    const back = JSON.parse(JSON.stringify(r)) as unknown;
    expect(back).toEqual(r);
    expect(validateReport(back).ok).toBe(true);
  });

  it("names the file from the report's own run and attempt, with only safe characters", () => {
    const r = buildReport(base({ latest: run({ run_attempt: 3 }), viewedAttempt: { number: 2, run: run({ run_attempt: 2 }) } }));
    expect(reportFilename(r)).toBe("report-acme-synthetic-app-500-attempt2.json");
    expect(reportFilename({ ...r, repository: { owner: "../a b", repo: "x/y" } })).toBe("report-__a_b-x_y-500-attempt2.json");
  });
});
