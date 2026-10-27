// A shareable investigation report of one workflow run (schema `gha-ui.investigation-report`, version 1), built only
// from evidence the app already holds. Pure: no I/O, nothing is fetched to build it, and nothing is uploaded; export
// is an explicit user action elsewhere.
//
// Contract:
// - Every evidence section has an explicit state: included, partial (included, with what is missing), not loaded
//   (the user did not load or open it), unavailable (loading failed) or not applicable. Absent evidence is never
//   written as an empty list.
// - Findings are copied with the models' own wording and basis. The report states what GitHub's data shows; it never
//   names a proven cause. The failure that completed first is "completed first", not "the cause".
// - A shared commit is never written as a deployment of a release or a publication of an artifact; artifacts are
//   listed for the whole run, never for an attempt.
// - Privacy: no tokens, authorization headers, workflow source, full logs, raw API responses or download URLs.
//   Log text appears only as excerpts the user selected, bounded in size, with credential-shaped text masked and
//   flagged. URLs are GitHub web links of the run's own host, without query or fragment.
import type { ArtifactSummary } from "../insights/artifacts";
import type { Impact } from "../insights/impact";
import type { ReleaseEvidenceSummary } from "../insights/release-evidence";
import type { Job, RepoRef, Run } from "../types";

export const REPORT_SCHEMA = "gha-ui.investigation-report";
export const REPORT_VERSION = 1;
export const REPORT_LIMITS = { excerpts: 10, linesPerExcerpt: 200, charsPerLine: 2000, jobs: 100, items: 100 };

export const EXCERPT_WARNING =
  "Log excerpts are copied exactly as selected, apart from masked credential-shaped text. Logs can contain secrets, internal host names or personal data: review every excerpt before sharing.";
export const NO_CAUSE_NOTE = "This report records what GitHub's data shows. It does not establish the cause of a failure.";
export const NO_EXCERPTS_NOTE = "No log excerpts were included. This does not mean the logs hold no relevant lines; logs are never included in full.";

/**
 * Whether selected lines can become an excerpt, before they are added: a selection over a limit is refused (the user
 * shortens it), never cut. `longLines` are the 0-based offsets of lines that `buildReport` would cut to
 * `charsPerLine`; the caller shows them and asks before adding.
 */
export function checkExcerpt(lines: string[], excerptsHeld: number): { error?: string; longLines: number[] } {
  const longLines = lines.flatMap((l, i) => (l.length > REPORT_LIMITS.charsPerLine ? [i] : []));
  const error = checkExcerptSize(lines.length, excerptsHeld);
  return error ? { error, longLines } : { longLines };
}

/** The count limits alone, so a range can be refused before its lines are read. */
export function checkExcerptSize(lineCount: number, excerptsHeld: number): string | undefined {
  if (excerptsHeld >= REPORT_LIMITS.excerpts) return `The report already holds ${REPORT_LIMITS.excerpts} excerpts, the most it can; remove one first.`;
  if (lineCount <= 0) return "Select at least one line.";
  if (lineCount > REPORT_LIMITS.linesPerExcerpt) return `The selection has ${lineCount} lines; an excerpt can hold at most ${REPORT_LIMITS.linesPerExcerpt}. Shorten it.`;
  return undefined;
}

/** `report-<owner>-<repo>-<run>-attempt<N>.json`, from the report's own identity; anything but [A-Za-z0-9._-] becomes "_". */
export function reportFilename(report: Pick<InvestigationReport, "repository" | "run">): string {
  const safe = (s: string | number) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return `report-${safe(report.repository.owner)}-${safe(report.repository.repo)}-${safe(report.run.id)}-attempt${safe(report.run.viewedAttempt)}.json`;
}

/** How a source of evidence stands in the app when the report is made. */
export type Loaded<T> = { state: "not loaded" } | { state: "unavailable"; reason: string } | { state: "loaded"; value: T; /** What the loaded evidence is known to miss. */ missing?: string[] };

export type SectionState = "included" | "partial" | "not loaded" | "unavailable" | "not applicable";
export type Section<T> = { state: SectionState; reason?: string; missing?: string[]; data?: T };

/**
 * The comparison findings the report uses; `RunComparison` (domain/compare/runs.ts) satisfies it. Declared here
 * because the domain lint rule reserves import paths ending in `runs` for the loaders.
 */
export type ComparisonFindings = {
  comparable: { ok: boolean; reasons: string[] };
  conclusion: { changed: boolean };
  counts: { outcome: number; added: number; removed: number; slower: number; faster: number; nowFailing: number; nowPassing: number };
  jobs: { key: string; label: string; change: string; baseStatus?: string; headStatus?: string }[];
  workflow: { file: "same" | "changed" | "unavailable" };
  summary: string[];
  notes: string[];
};

export type ExcerptInput = { jobId: number; stepNumber?: number; startLine: number; lines: string[] };

export type ReportInput = {
  mode: "live" | "fixtures";
  repo: RepoRef;
  /** The run as GitHub reports it now (its latest attempt). */
  latest: Run;
  /** The attempt on screen, when it is not the latest, and that attempt's own run data. */
  viewedAttempt?: { number: number; run: Run };
  /** The jobs of the attempt on screen. */
  jobs: Loaded<Job[]>;
  impact: Loaded<Impact>;
  comparison?: Loaded<{ base: Run; baseAttempt: number; comparison: ComparisonFindings }>;
  excerpts?: ExcerptInput[];
  deployments: Loaded<Pick<ReleaseEvidenceSummary, "deployments" | "otherCommits" | "notes">>;
  releases: Loaded<Pick<ReleaseEvidenceSummary, "releases" | "malformedReleases" | "notes">>;
  artifacts: Loaded<ArtifactSummary>;
  /** ISO time the report is made. */
  generatedAt: string;
};

export type ReportLink = string;

export type InvestigationReport = {
  schema: typeof REPORT_SCHEMA;
  version: typeof REPORT_VERSION;
  generatedAt: string;
  /** Fixture mode data is synthetic, and the report says so. */
  source: { mode: "live" | "fixtures"; host: string | null; synthetic: boolean };
  repository: { owner: string; repo: string; url?: ReportLink };
  run: {
    id: number;
    number?: number;
    name: string | null;
    title: string;
    workflowPath?: string;
    event: string;
    branch: string | null;
    commit: string;
    status: string;
    conclusion: string | null;
    createdAt?: string;
    startedAt?: string;
    updatedAt?: string;
    url?: ReportLink;
    latestAttempt: number;
    viewedAttempt: number;
    attemptNote: string;
  };
  failures: Section<{
    jobs: { id: number; name: string; conclusion: string | null; attempt?: number; step?: { number: number; name: string; conclusion: string | null }; completedAt?: string; url?: ReportLink }[];
    impact?: {
      dependencies: Impact["dependencies"];
      completedFirst?: { job: string; at: string; tiedWith: string[] };
      failures: { key: string; label: string; kind: string; failedUpstream: string[]; downstream: { key: string; reason: string }[]; untraced: boolean }[];
      notes: string[];
    };
  }>;
  comparison: Section<{
    base: { id: number; attempt: number; conclusion: string | null; commit: string; url?: ReportLink };
    comparable: { ok: boolean; reasons: string[] };
    conclusionChanged: boolean;
    counts: ComparisonFindings["counts"];
    changedJobs: { key: string; label: string; change: string; baseStatus?: string; headStatus?: string }[];
    workflowFile: ComparisonFindings["workflow"]["file"];
    summary: string[];
    notes: string[];
  }>;
  logExcerpts: Section<{
    warning: string;
    excerpts: { jobId: number; job: string; step?: number; startLine: number; endLine: number; lines: string[]; truncated: boolean; masked: number }[];
  }>;
  deployments: Section<{ items: { id: number; environment: string | null; commit: string | null; association: string; outcome: string; basis: string[] }[]; otherCommits: number; notes: string[] }>;
  releases: Section<{ items: { id: number; tag: string; draft: boolean; prerelease: boolean; commitMatch: string; commitBasis: string[]; runRelation: string; url?: ReportLink }[]; malformed: number; notes: string[] }>;
  artifacts: Section<{
    listing: ArtifactSummary["listing"];
    attempt: ArtifactSummary["attempt"];
    read: number;
    totalCount: number | null;
    malformed: number;
    items: { id: number; name: string; sizeInBytes: number; expired: boolean; expiresAt?: string; digest?: string; association: string; basis: string }[];
    notes: string[];
  }>;
  caveats: string[];
  privacy: { tokens: false; fullLogs: false; workflowSource: false; rawResponses: false; downloadUrls: false; excerpts: number };
};

// ---- privacy helpers ----------------------------------------------------------------------------------------------

/** Credential-shaped text (GitHub tokens, bearer/basic credentials, cloud keys, private keys, key=value secrets). */
const CREDENTIALS: RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9_\-.=+/]{8,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)(\s*[:=]\s*)(?!\[masked\])("[^"]*"|'[^']*'|[^\s"']+)/gi,
  /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/g,
];

/** What masked text is replaced with (the preview highlights it). */
export const MASK = "[masked]";

/** Masks credential-shaped text; returns the text and how many matches were masked. */
export function maskCredentials(line: string): { text: string; masked: number } {
  let masked = 0;
  let text = line;
  CREDENTIALS.forEach((re, i) => {
    text = text.replace(re, (...m: string[]) => {
      masked++;
      if (i === 1) return `${m[1]} ${MASK}`;
      if (i === 4) return `${m[1]}${m[2]}${MASK}`;
      if (i === 5) return `https://${MASK}@`;
      return MASK;
    });
  });
  return { text, masked };
}

/** True when the text still looks like it holds a credential (used to validate a finished report). */
export const hasCredential = (text: string) => CREDENTIALS.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text));

/** A GitHub web link on the run's own host, without credentials, query or fragment; anything else is dropped. */
function link(url: string | null | undefined, host: string | null): ReportLink | undefined {
  if (!url || !host) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.host !== host || u.username || u.password) return undefined;
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

// ---- sections -----------------------------------------------------------------------------------------------------

function section<T, D>(loaded: Loaded<T> | undefined, build: (value: T) => D, whenAbsent: SectionState = "not loaded"): Section<D> {
  if (!loaded || loaded.state === "not loaded") return { state: whenAbsent };
  if (loaded.state === "unavailable") return { state: "unavailable", reason: loaded.reason };
  const missing = loaded.missing?.filter(Boolean) ?? [];
  return { state: missing.length ? "partial" : "included", ...(missing.length && { missing }), data: build(loaded.value) };
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);
const cap = <T>(list: T[], n: number, missing: string[], what: string) => {
  if (list.length > n) missing.push(`Only the first ${n} of ${list.length} ${what} are included.`);
  return list.slice(0, n);
};

export function buildReport(input: ReportInput): InvestigationReport {
  const { latest, viewedAttempt } = input;
  const shown = viewedAttempt?.run ?? latest;
  let host: string | null = null;
  try {
    host = new URL(latest.html_url).host;
  } catch {
    // Without the run's own URL no link is included.
  }
  const caveats = [NO_CAUSE_NOTE];
  const shownAttempt = viewedAttempt?.number ?? latest.run_attempt;
  const earlier = shownAttempt !== latest.run_attempt;
  const attemptNote = earlier
    ? `Attempt ${shownAttempt} of ${latest.run_attempt} (not the latest). Jobs, failures and log excerpts are from attempt ${shownAttempt}; deployments, releases and artifacts are recorded per run or commit, not per attempt.`
    : latest.run_attempt > 1
      ? `Attempt ${shownAttempt}, the latest of ${latest.run_attempt}. Deployments, releases and artifacts are recorded per run or commit, not per attempt.`
      : "The run had one attempt when the report was made.";
  if (input.mode === "fixtures") caveats.push("Made in fixture mode: the data is synthetic or a pinned fixture, not live GitHub data.");
  if (shown.status !== "completed") caveats.push("The run had not completed when the report was made; its results may change.");

  // Failures: the failed jobs of the attempt on screen, and the impact analysis when it was available.
  const jobsMissing: string[] = [];
  const failures: InvestigationReport["failures"] =
    input.jobs.state !== "loaded"
      ? section(input.jobs, () => ({ jobs: [] }))
      : (() => {
          const failed = cap(
            input.jobs.value.filter((j) => j.conclusion !== null && FAILED.has(j.conclusion)),
            REPORT_LIMITS.jobs,
            jobsMissing,
            "failed jobs",
          );
          const jobs = failed.map((j) => {
            const step = j.steps?.find((s) => s.conclusion !== null && FAILED.has(s.conclusion));
            return {
              id: j.id,
              name: j.name,
              conclusion: j.conclusion,
              ...(j.run_attempt !== undefined && { attempt: j.run_attempt }),
              ...(step && { step: { number: step.number, name: step.name, conclusion: step.conclusion } }),
              ...(j.completed_at && { completedAt: j.completed_at }),
              ...(link(j.html_url, host) && { url: link(j.html_url, host) }),
            };
          });
          if (input.impact.state === "not loaded") jobsMissing.push("Failure impact was not analysed.");
          if (input.impact.state === "unavailable") jobsMissing.push(`Failure impact is unavailable: ${input.impact.reason}`);
          if (input.impact.state === "loaded" && input.impact.value.dependencies === "unavailable") jobsMissing.push("The workflow file's dependencies were unavailable, so downstream impact is not traced.");
          const impact =
            input.impact.state === "loaded"
              ? {
                  dependencies: input.impact.value.dependencies,
                  ...(input.impact.value.earliest && {
                    completedFirst: { job: input.impact.value.earliest.job.name, at: input.impact.value.earliest.at, tiedWith: input.impact.value.earliest.tied },
                  }),
                  failures: input.impact.value.failures.slice(0, REPORT_LIMITS.items).map((f) => ({
                    key: f.key,
                    label: f.label,
                    kind: f.kind,
                    failedUpstream: f.failedUpstream,
                    downstream: f.downstream.map((d) => ({ key: d.key, reason: d.reason })),
                    untraced: f.untraced,
                  })),
                  notes: input.impact.value.notes,
                }
              : undefined;
          return { state: jobsMissing.length ? "partial" : "included", ...(jobsMissing.length && { missing: jobsMissing }), data: { jobs, ...(impact && { impact }) } };
        })();
  if (failures.data?.impact?.completedFirst) caveats.push("\"Completed first\" is the order of GitHub's timestamps, not evidence of which failure caused the others.");

  const comparison = section(input.comparison, ({ base, baseAttempt, comparison: c }) => ({
    base: { id: base.id, attempt: baseAttempt, conclusion: base.conclusion, commit: base.head_sha, ...(link(base.html_url, host) && { url: link(base.html_url, host) }) },
    comparable: c.comparable,
    conclusionChanged: c.conclusion.changed,
    counts: c.counts,
    changedJobs: c.jobs
      .filter((j) => j.change !== "same")
      .slice(0, REPORT_LIMITS.jobs)
      .map((j) => ({ key: j.key, label: j.label, change: j.change, ...(j.baseStatus && { baseStatus: j.baseStatus }), ...(j.headStatus && { headStatus: j.headStatus }) })),
    // Only whether the file changed; its text and diff are never included.
    workflowFile: c.workflow.file,
    summary: c.summary,
    notes: c.notes,
  }));

  // Log excerpts: only those selected, bounded, credential-shaped text masked.
  const excerptsIn = input.excerpts ?? [];
  const excerptMissing: string[] = [];
  const jobName = new Map((input.jobs.state === "loaded" ? input.jobs.value : []).map((j) => [j.id, j.name]));
  const excerpts = cap(excerptsIn, REPORT_LIMITS.excerpts, excerptMissing, "selected excerpts").map((e) => {
    const lines = e.lines.slice(0, REPORT_LIMITS.linesPerExcerpt);
    let masked = 0;
    const out = lines.map((l) => {
      const m = maskCredentials(l.length > REPORT_LIMITS.charsPerLine ? `${l.slice(0, REPORT_LIMITS.charsPerLine)}…` : l);
      masked += m.masked;
      return m.text;
    });
    const truncated = e.lines.length > lines.length || lines.some((l) => l.length > REPORT_LIMITS.charsPerLine);
    if (truncated) excerptMissing.push(`An excerpt of job ${e.jobId} was shortened to the report's limits.`);
    return { jobId: e.jobId, job: jobName.get(e.jobId) ?? `#${e.jobId}`, ...(e.stepNumber !== undefined && { step: e.stepNumber }), startLine: e.startLine, endLine: e.startLine + lines.length - 1, lines: out, truncated, masked };
  });
  const logExcerpts: InvestigationReport["logExcerpts"] = excerpts.length
    ? { state: excerptMissing.length ? "partial" : "included", ...(excerptMissing.length && { missing: [...new Set(excerptMissing)] }), data: { warning: EXCERPT_WARNING, excerpts } }
    : { state: "not applicable", reason: NO_EXCERPTS_NOTE };

  const deployments = section(input.deployments, (d) => ({
    items: d.deployments.slice(0, REPORT_LIMITS.items).map((x) => ({ id: x.id, environment: x.environment, commit: x.sha, association: x.association, outcome: x.outcome, basis: x.basis })),
    otherCommits: d.otherCommits,
    notes: d.notes,
  }));
  const releases = section(input.releases, (r) => ({
    items: r.releases.slice(0, REPORT_LIMITS.items).map((x) => ({
      id: x.id,
      tag: x.tag,
      draft: x.draft,
      prerelease: x.prerelease,
      commitMatch: x.commit.match,
      commitBasis: x.commit.basis,
      runRelation: x.run.relation,
      ...(link(x.url, host) && { url: link(x.url, host) }),
    })),
    malformed: r.malformedReleases,
    notes: r.notes,
  }));
  const artifacts = section(input.artifacts, (a) => ({
    listing: a.listing,
    attempt: a.attempt,
    read: a.read,
    totalCount: a.totalCount,
    malformed: a.malformed,
    items: a.artifacts.slice(0, REPORT_LIMITS.items).map((x) => ({
      id: x.id,
      name: x.name,
      sizeInBytes: x.sizeInBytes,
      expired: x.expired,
      ...(x.expiresAt && { expiresAt: x.expiresAt }),
      ...(x.digest && { digest: x.digest }),
      association: x.association,
      basis: x.basis,
    })),
    notes: a.notes,
  }));
  if (artifacts.data && (artifacts.data.listing === "incomplete" || artifacts.data.malformed > 0)) {
    artifacts.state = "partial";
    artifacts.missing = [...(artifacts.missing ?? []), artifacts.data.listing === "incomplete" ? `${artifacts.data.read} of ${artifacts.data.totalCount} listed artifacts were read.` : `${artifacts.data.malformed} malformed artifact records were left out.`];
  }
  // Lists cut to the report's limit are partial, with how much was left out.
  const trimmed = (sec: Section<unknown>, total: number, what: string) => {
    if (!sec.data || total <= REPORT_LIMITS.items) return;
    sec.state = "partial";
    sec.missing = [...(sec.missing ?? []), `Only the first ${REPORT_LIMITS.items} of ${total} ${what} are included.`];
  };
  if (input.deployments.state === "loaded") trimmed(deployments, input.deployments.value.deployments.length, "deployments");
  if (input.releases.state === "loaded") trimmed(releases, input.releases.value.releases.length, "releases");
  if (input.artifacts.state === "loaded") trimmed(artifacts, input.artifacts.value.artifacts.length, "artifacts");
  if (deployments.data || releases.data) caveats.push("A shared commit does not establish that a release was deployed or that an artifact was published or used.");

  return {
    schema: REPORT_SCHEMA,
    version: REPORT_VERSION,
    generatedAt: input.generatedAt,
    source: { mode: input.mode, host, synthetic: input.mode === "fixtures" },
    repository: { owner: input.repo.owner, repo: input.repo.repo, ...(host && { url: `https://${host}/${input.repo.owner}/${input.repo.repo}` }) },
    run: {
      id: latest.id,
      ...(latest.run_number !== undefined && { number: latest.run_number }),
      name: latest.name,
      title: latest.display_title,
      ...(latest.path && { workflowPath: latest.path }),
      event: latest.event,
      branch: latest.head_branch,
      commit: latest.head_sha,
      status: shown.status,
      conclusion: shown.conclusion,
      ...(shown.created_at && { createdAt: shown.created_at }),
      ...(shown.run_started_at && { startedAt: shown.run_started_at }),
      ...(shown.updated_at && { updatedAt: shown.updated_at }),
      ...(link(earlier ? `${latest.html_url}/attempts/${shownAttempt}` : latest.html_url, host) && { url: link(earlier ? `${latest.html_url}/attempts/${shownAttempt}` : latest.html_url, host) }),
      latestAttempt: latest.run_attempt,
      viewedAttempt: shownAttempt,
      attemptNote,
    },
    failures,
    comparison,
    logExcerpts,
    deployments,
    releases,
    artifacts,
    caveats,
    privacy: { tokens: false, fullLogs: false, workflowSource: false, rawResponses: false, downloadUrls: false, excerpts: excerpts.length },
  };
}

// ---- validation ---------------------------------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["authorization", "token", "archive_download_url", "workflowText", "workflow_text", "log", "logs", "raw", "headers"]);
const STATES = new Set<SectionState>(["included", "partial", "not loaded", "unavailable", "not applicable"]);
const SECTIONS = ["failures", "comparison", "logExcerpts", "deployments", "releases", "artifacts"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks a report (built here or read back) against the version 1 contract, including its privacy rules. */
export function validateReport(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["The report is not an object."] };
  if (value.schema !== REPORT_SCHEMA) errors.push(`Unknown schema: expected ${REPORT_SCHEMA}.`);
  if (value.version !== REPORT_VERSION) errors.push(`Unsupported version ${String(value.version)}; this reader understands version ${REPORT_VERSION}.`);
  const run = value.run;
  if (!isRecord(run) || typeof run.id !== "number" || typeof run.commit !== "string" || typeof run.latestAttempt !== "number" || typeof run.viewedAttempt !== "number") errors.push("The run identity is incomplete.");
  if (!isRecord(value.repository) || typeof value.repository.owner !== "string" || typeof value.repository.repo !== "string") errors.push("The repository identity is incomplete.");
  for (const name of SECTIONS) {
    const s = value[name];
    if (!isRecord(s) || !STATES.has(s.state as SectionState)) errors.push(`Section ${name} has no valid state.`);
    else if ((s.state === "included" || s.state === "partial") && s.data === undefined) errors.push(`Section ${name} is ${s.state} but has no data.`);
    else if (s.state !== "included" && s.state !== "partial" && s.data !== undefined) errors.push(`Section ${name} is ${s.state} but carries data.`);
  }
  const excerpts = isRecord(value.logExcerpts) && isRecord(value.logExcerpts.data) && Array.isArray(value.logExcerpts.data.excerpts) ? value.logExcerpts.data.excerpts : [];
  if (excerpts.length > REPORT_LIMITS.excerpts) errors.push("Too many log excerpts.");
  for (const e of excerpts) if (!isRecord(e) || !Array.isArray(e.lines) || e.lines.length > REPORT_LIMITS.linesPerExcerpt) errors.push("A log excerpt exceeds the line limit.");
  if (excerpts.length && !(isRecord(value.logExcerpts) && isRecord(value.logExcerpts.data) && value.logExcerpts.data.warning === EXCERPT_WARNING)) errors.push("Log excerpts are present without the sensitivity warning.");
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isRecord(v)) for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) errors.push(`Forbidden field ${path}.${k}.`);
      walk(x, `${path}.${k}`);
    }
    else if (typeof v === "string" && hasCredential(v)) errors.push(`Credential-shaped text at ${path}.`);
  };
  walk(value, "report");
  return { ok: errors.length === 0, errors };
}
