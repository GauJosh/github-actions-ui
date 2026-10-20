// A deterministic synthetic run whose single log is just above the A8 soft limit (46,000,000 bytes),
// generated on demand from fixed-width lines so any byte range can be produced without storing it.

const LINE = 100;
const LINES = 460_000;
const TAIL_LINES = [
  "##[group]Run ./scripts/check.sh",
  "Synthetic failure: expected 1 but got 2 (fixture mode, large log)",
  "##[endgroup]",
  "##[error]Process completed with exit code 1.",
];

export const SYNTHETIC_LARGE = { runId: 990000001, jobId: 990000002, bytes: LINE * LINES, owner: "fixtures", repo: "synthetic" };

function line(n: number): string {
  const stamp = "2026-10-20T00:00:00.0000000Z ";
  const special = n - (LINES - TAIL_LINES.length);
  const text = special >= 0 ? TAIL_LINES[special]! : `synthetic line ${String(n + 1).padStart(9, "0")} lorem ipsum`;
  return (stamp + text).padEnd(LINE - 1, " ").slice(0, LINE - 1) + "\n";
}

/** Bytes [start, end) of the synthetic log. All characters are ASCII, so bytes equal characters. */
export function syntheticLog(start: number, end: number): Buffer {
  let out = "";
  for (let n = Math.floor(start / LINE); n * LINE < end; n++) out += line(n);
  const base = Math.floor(start / LINE) * LINE;
  return Buffer.from(out.slice(start - base, end - base), "latin1");
}

const htmlBase = "https://github.com/fixtures/synthetic/actions/runs/990000001";

export const syntheticRun = {
  indexEntry: { owner: SYNTHETIC_LARGE.owner, repo: SYNTHETIC_LARGE.repo, runId: SYNTHETIC_LARGE.runId, title: "[synthetic] Large log (46 MB, fail)", conclusion: "failure" },
  run: {
    id: SYNTHETIC_LARGE.runId,
    name: "[synthetic] Large log",
    display_title: "[synthetic] Large log (46 MB, fail)",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    head_branch: "main",
    head_sha: "0000000000000000000000000000000000000000",
    html_url: htmlBase,
    event: "workflow_dispatch",
  },
};

export function syntheticJobs() {
  return {
    total_count: 1,
    jobs: [
      {
        id: SYNTHETIC_LARGE.jobId,
        name: "large",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-10-20T00:00:00Z",
        completed_at: "2026-10-20T00:05:00Z",
        html_url: `${htmlBase}/job/${SYNTHETIC_LARGE.jobId}`,
        run_attempt: 1,
        steps: [
          { number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: null, completed_at: null },
          { number: 2, name: "Run ./scripts/check.sh", status: "completed", conclusion: "failure", started_at: null, completed_at: null },
          { number: 3, name: "Complete job", status: "completed", conclusion: "success", started_at: null, completed_at: null },
        ],
      },
    ],
  };
}
