import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Job, Run } from "../types";
import { buildRunGraph, durationMs, jobStatus } from "./build";
import { layoutGraph } from "./layout";
import { readWorkflowDefinition, type WorkflowDefinition } from "./workflow-definition";

const COMMIT = (JSON.parse(readFileSync("fixtures.lock.json", "utf8")) as { commit: string }).commit;
const dir = (repo: string, run: number) => `.fixtures/${COMMIT}/fixtures/GauJosh__${repo}/${run}`;

function realRun(repo: string, runId: number) {
  const d = dir(repo, runId);
  const run = JSON.parse(readFileSync(`${d}/run.json`, "utf8")) as Run;
  const jobs = (JSON.parse(readFileSync(`${d}/attempts/1/jobs.json`, "utf8")) as { jobs: Job[] }).jobs;
  const def = readWorkflowDefinition(parse(readFileSync(`${d}/workflow.yml`, "utf8")));
  if ("error" in def) throw new Error(def.error);
  return { run, jobs, def, file: { path: run.path!, revision: run.head_sha } };
}

const job = (id: number, name: string, conclusion: string | null = "success", status = "completed", times: [string?, string?] = []): Job => ({
  id,
  name,
  status,
  conclusion,
  started_at: times[0] ?? null,
  completed_at: times[1] ?? null,
  html_url: null,
});

const def = (jobs: WorkflowDefinition["jobs"]): WorkflowDefinition => ({ jobs, problems: [] });
const d = (id: string, extra: Partial<WorkflowDefinition["jobs"][number]> = {}): WorkflowDefinition["jobs"][number] => ({ id, needs: [], matrix: false, hasIf: false, steps: [], ...extra });
const FILE = { file: { path: ".github/workflows/ci.yml", revision: "abc1234" } };

describe("workflow definition", () => {
  it("reads needs (string or list), matrix, reusable calls and conditions", () => {
    const result = readWorkflowDefinition(
      parse(`
jobs:
  a: { runs-on: x }
  b: { needs: a, strategy: { matrix: { os: [1, 2] } } }
  c: { needs: [a, b], if: always() }
  d: { uses: ./.github/workflows/r.yml, needs: c }
`),
    );
    expect(result).toMatchObject({
      problems: [],
      jobs: [
        { id: "a", needs: [], matrix: false, hasIf: false },
        { id: "b", needs: ["a"], matrix: true, hasIf: false },
        { id: "c", needs: ["a", "b"], matrix: false, hasIf: true, ifCondition: "always()" },
        { id: "d", needs: ["c"], matrix: false, uses: "./.github/workflows/r.yml", hasIf: false },
      ],
    });
  });

  it("reports malformed files instead of guessing", () => {
    expect(readWorkflowDefinition("text")).toEqual({ error: "The workflow file is not a YAML mapping" });
    expect(readWorkflowDefinition({ on: "push" })).toEqual({ error: "The workflow file has no `jobs` mapping" });
    const odd = readWorkflowDefinition({ jobs: { a: { needs: { x: 1 } }, b: "nope" } });
    expect("error" in odd ? [] : odd.problems).toHaveLength(2);
  });
});

describe("graph from real fixture runs (workflow file at the run's commit)", () => {
  it("s05 cascade: needs chain and fan-in, exactly as declared", () => {
    const { run, jobs, def, file } = realRun("gha-ui-fixtures", 39366120652);
    const g = buildRunGraph(jobs, def, { run, file });
    expect(g.nodes.map((n) => n.yamlId)).toEqual(["build", "test", "deploy", "report"]);
    expect(g.edges).toEqual([
      { from: "def:build", to: "def:test" },
      { from: "def:test", to: "def:deploy" },
      { from: "def:build", to: "def:report" },
      { from: "def:test", to: "def:report" },
      { from: "def:deploy", to: "def:report" },
    ]);
    expect(g.evidence).toMatchObject({ kind: "workflow-file", matchedJobs: 4, totalJobs: 4 });
    expect(g.nodes.find((n) => n.yamlId === "build")!.status).toBe("failure");
    expect(g.nodes.find((n) => n.yamlId === "deploy")!.status).toBe("skipped");
    const layout = layoutGraph(g.nodes.map((n) => ({ key: n.key, height: 60 })), g.edges);
    expect(["def:build", "def:test", "def:deploy", "def:report"].map((k) => layout.boxes.get(k)!.layer)).toEqual([0, 1, 2, 3]);
  });

  it("KAI CI: a templated matrix name groups all 7 legs; `build` needs the matrix", () => {
    const { run, jobs, def, file } = realRun("kubernetes-ai-investigator", 38850578511);
    const g = buildRunGraph(jobs, def, { run, file });
    const test = g.nodes.find((n) => n.yamlId === "test")!;
    expect(test.kind).toBe("matrix");
    expect(test.members).toHaveLength(7);
    expect(test.counts).toEqual({ failure: 2, success: 5 });
    expect(test.status).toBe("failure");
    expect(g.nodes.find((n) => n.yamlId === "build")!.label).toBe("build distributable package");
    expect(g.edges).toEqual([{ from: "def:test", to: "def:build" }]);
    expect(g.evidence).toMatchObject({ matchedJobs: 8, totalJobs: 8 });
  });

  it("s12: the reusable-workflow call groups its inner job and records the resolved commit", () => {
    const { run, jobs, def, file } = realRun("gha-ui-fixtures", 39366137075);
    const g = buildRunGraph(jobs, def, { run, file });
    const reusable = g.nodes.find((n) => n.yamlId === "via-reusable")!;
    expect(reusable.kind).toBe("reusable");
    expect(reusable.members.map((m) => m.label)).toEqual(["inner-test"]);
    expect(reusable.resolvedWorkflow?.sha).toBe("4e73dc9b02850c7d0c33c9212477f22ce10d30bc");
    expect(g.edges).toEqual([]);
    expect(g.evidence.notes).toContain("Dependencies inside called (reusable) workflows are not shown.");
  });
});

describe("no invented structure", () => {
  const jobs = [job(1, "lint"), job(2, "test (a)"), job(3, "test (b)"), job(4, "deploy / prod"), job(5, "build")];

  it("without a workflow file: no edges at all, and name-based groups are labelled as such", () => {
    const g = buildRunGraph(jobs, null, { unavailableReason: "403" });
    expect(g.edges).toEqual([]);
    expect(g.evidence).toMatchObject({ kind: "unavailable", reason: "403" });
    expect(g.nodes.find((n) => n.kind === "matrix")).toMatchObject({ source: "job-name", label: "test" });
    expect(g.nodes.find((n) => n.kind === "reusable")).toMatchObject({ source: "job-name", label: "deploy" });
    expect(g.evidence.notes.join(" ")).toMatch(/based on job names only/);
  });

  it("a single parenthesised job is not treated as a matrix", () => {
    expect(buildRunGraph([job(1, "e2e (chrome)")], null).nodes[0]!.kind).toBe("job");
  });

  it("jobs that do not match the workflow file get no edges", () => {
    const g = buildRunGraph([job(1, "build"), job(2, "renamed-test")], def([d("build"), d("test", { needs: ["build"] })]), FILE);
    // `test` has no job in this run (it was renamed), so there is no node to draw an edge to.
    expect(g.edges).toEqual([]);
    const unmatched = g.nodes.find((n) => n.key === "job:2")!;
    expect(unmatched.source).toBe("job-name");
    expect(g.edges.some((e) => e.from === "job:2" || e.to === "job:2")).toBe(false);
    expect(g.nodes.some((n) => n.yamlId === "test")).toBe(false);
    expect(g.declared).toEqual([{ key: "def:test", id: "test", label: "test", needs: ["build"] }]);
    expect(g.evidence.notes.join(" ")).toMatch(/1 job could not be matched/);
  });

  it("declared jobs with no job in the run are context, not nodes: no synthetic CI stage, no invented or bridged edges", () => {
    // A deployment-only run: the workflow declares a CI call and a build job, GitHub reported neither.
    const definition = def([
      d("ci", { uses: "./.github/workflows/ci.yml" }),
      d("package", { needs: ["ci"] }),
      d("deploy", { needs: ["package"], environment: "eu" }),
      d("verify", { needs: ["deploy"] }),
    ]);
    const g = buildRunGraph([job(1, "deploy"), job(2, "verify")], definition, FILE);
    expect(g.nodes.map((n) => n.key)).toEqual(["def:deploy", "def:verify"]);
    expect(g.edges).toEqual([{ from: "def:deploy", to: "def:verify" }]);
    expect(g.declared!.map((x) => x.key)).toEqual(["def:ci", "def:package"]);
    expect(g.declared![0]).toMatchObject({ uses: "./.github/workflows/ci.yml" });
    // `deploy` needs `package`, which needs `ci`: neither ran, so nothing upstream of deploy is drawn or bridged.
    expect(g.evidence.notes.join(" ")).toContain("Not drawn: `deploy` needs `package`");
    expect(g.evidence.notes.join(" ")).toContain("2 jobs are declared in the workflow file but have no matching job in this run (`ci`, `package`)");
    expect(g.evidence.kind === "workflow-file" && g.evidence.matchedJobs).toBe(2);
  });

  it("arbitrary job names and topologies: edges are exactly the `needs` between jobs that ran", () => {
    const definition = def([
      d("alpha"),
      d("omega"),
      d("zeta", { needs: ["alpha", "omega"] }),
      d("kappa", { needs: ["alpha"] }),
      d("final", { needs: ["zeta", "kappa"], hasIf: true }),
    ]);
    const names = ["omega", "alpha", "kappa", "zeta", "final"];
    const g = buildRunGraph(names.map((n, i) => job(i + 1, n, n === "final" ? "skipped" : "success")), definition, FILE);
    expect(g.declared).toBeUndefined();
    expect(g.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["def:alpha>def:kappa", "def:alpha>def:zeta", "def:kappa>def:final", "def:omega>def:zeta", "def:zeta>def:final"]);
    expect(g.nodes.find((n) => n.key === "def:final")!.status).toBe("skipped");
  });

  it("a `needs` on an undefined job draws no edge and says so", () => {
    const g = buildRunGraph([job(1, "a")], def([d("a", { needs: ["ghost"] })]), FILE);
    expect(g.edges).toEqual([]);
    expect(g.evidence.notes.join(" ")).toMatch(/needs `ghost`/);
  });

  it("an ambiguous job name is left unmatched rather than guessed", () => {
    const g = buildRunGraph([job(1, "x-1")], def([d("a", { name: "x-${{ matrix.n }}" }), d("b", { name: "${{ inputs.p }}-1" })]), FILE);
    expect(g.nodes.find((n) => n.key === "job:1")).toBeDefined();
    expect(g.evidence.notes.join(" ")).toMatch(/matched more than one job definition/);
  });

  it("an exact name wins over a pattern", () => {
    const g = buildRunGraph([job(1, "deploy")], def([d("deploy"), d("other", { name: "${{ inputs.target }}" })]), FILE);
    expect(g.nodes.find((n) => n.yamlId === "deploy")!.members).toHaveLength(1);
  });
});

describe("status and timing", () => {
  it("maps job states, including waiting, queued and unknown conclusions", () => {
    expect(jobStatus({ status: "completed", conclusion: "startup_failure" })).toBe("failure");
    expect(jobStatus({ status: "completed", conclusion: "action_required" })).toBe("waiting");
    expect(jobStatus({ status: "waiting", conclusion: null })).toBe("waiting");
    expect(jobStatus({ status: "pending", conclusion: null })).toBe("queued");
    expect(jobStatus({ status: "completed", conclusion: "stale" })).toBe("unknown");
  });

  it("groups report the most important state, and end times only when every job finished", () => {
    const g = buildRunGraph(
      [job(1, "t (1)", "success", "completed", ["2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"]), job(2, "t (2)", null, "in_progress", ["2026-01-01T00:00:30Z"])],
      def([d("t", { matrix: true })]),
      FILE,
    );
    const node = g.nodes[0]!;
    expect(node.status).toBe("in_progress");
    expect(node.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(node.completedAt).toBeUndefined();
  });

  it("durations need both timestamps in order", () => {
    expect(durationMs("2026-01-01T00:00:00Z", "2026-01-01T00:01:05Z")).toBe(65_000);
    expect(durationMs("2026-01-01T00:00:00Z", null)).toBeUndefined();
    expect(durationMs("2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z")).toBeUndefined();
  });
});

describe("layout", () => {
  it("places parallel branches in one layer and fan-in after them", () => {
    const nodes = ["a", "b", "c", "d"].map((key) => ({ key, height: 60 }));
    const l = layoutGraph(nodes, [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ]);
    expect(["a", "b", "c", "d"].map((k) => l.boxes.get(k)!.layer)).toEqual([0, 1, 1, 2]);
    expect(l.boxes.get("b")!.y).not.toBe(l.boxes.get("c")!.y);
    expect(l.edges).toHaveLength(4);
  });

  it("lays out nodes without edges in a grid and draws nothing between them", () => {
    const l = layoutGraph(Array.from({ length: 10 }, (_, i) => ({ key: `n${i}`, height: 60 })), []);
    expect(l.edges).toEqual([]);
    expect(new Set([...l.boxes.values()].map((b) => b.layer))).toEqual(new Set([0, 1]));
  });

  it("never loops or drops nodes on a cycle", () => {
    const l = layoutGraph(["a", "b", "c"].map((key) => ({ key, height: 60 })), [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "b" },
    ]);
    expect(l.boxes.size).toBe(3);
    expect(l.cyclic).toBe(true);
  });

  it("bundles a complete many-to-many dependency through one junction, keeping every relationship", () => {
    const sources = ["a1", "a2", "a3"];
    const targets = ["b1", "b2"];
    const nodes = [...sources, ...targets].map((key) => ({ key, height: 60 }));
    const edges = sources.flatMap((from) => targets.map((to) => ({ from, to })));
    const plain = layoutGraph(nodes, edges);
    expect(plain.edges).toHaveLength(6);
    const bundled = layoutGraph(nodes, edges, { bundle: true });
    expect(bundled.junctions).toHaveLength(1);
    expect(bundled.junctions[0]).toMatchObject({ sources, targets });
    expect(bundled.edges).toHaveLength(5);
    // Every source reaches every target through the junction.
    const j = `junction:${bundled.junctions[0]!.id}`;
    for (const s of sources) expect(bundled.edges.some((e) => e.from === s && e.to === j)).toBe(true);
    for (const t of targets) expect(bundled.edges.some((e) => e.from === j && e.to === t)).toBe(true);
  });

  it("does not bundle when targets have different prerequisites", () => {
    const nodes = ["a", "b", "c", "x", "y"].map((key) => ({ key, height: 60 }));
    const l = layoutGraph(nodes, [
      { from: "a", to: "x" },
      { from: "b", to: "x" },
      { from: "b", to: "y" },
      { from: "c", to: "y" },
    ], { bundle: true });
    expect(l.junctions).toEqual([]);
    expect(l.edges).toHaveLength(4);
  });

  it("places each lane in its own band, in declared order, with unlaned jobs last", () => {
    const nodes = [
      { key: "d-api", height: 60, lane: "api" },
      { key: "s-api", height: 60, lane: "api" },
      { key: "d-web", height: 60, lane: "web" },
      { key: "s-web", height: 60, lane: "web" },
      { key: "canary", height: 60 },
    ];
    const l = layoutGraph(nodes, [
      { from: "d-api", to: "s-api" },
      { from: "d-web", to: "s-web" },
      { from: "d-api", to: "canary" },
      { from: "d-web", to: "canary" },
    ]);
    expect(l.lanes.map((b) => b.label)).toEqual(["api", "web", "Other jobs"]);
    const band = (label: string) => l.lanes.find((b) => b.label === label)!;
    for (const [key, lane] of [["d-api", "api"], ["s-api", "api"], ["d-web", "web"], ["canary", "Other jobs"]] as const) {
      const b = l.boxes.get(key)!;
      expect(b.y).toBeGreaterThanOrEqual(band(lane).start);
      expect(b.y + b.height).toBeLessThanOrEqual(band(lane).start + band(lane).size);
    }
    expect(l.boxes.get("d-api")!.y).toBe(l.boxes.get("s-api")!.y);
  });

  it("routes an edge that skips a layer through a gap, not through a node", () => {
    const nodes = ["a", "m1", "m2", "m3", "z"].map((key) => ({ key, height: 60 }));
    const edges = [
      { from: "a", to: "m1" },
      { from: "a", to: "m2" },
      { from: "a", to: "m3" },
      { from: "m1", to: "z" },
      { from: "a", to: "z" },
    ];
    const l = layoutGraph(nodes, edges);
    const long = l.edges.find((e) => e.from === "a" && e.to === "z")!;
    const mids = ["m1", "m2", "m3"].map((k) => l.boxes.get(k)!);
    const col = mids[0]!;
    // The straight run across the middle column is at a y outside every box in that column.
    const across = new RegExp(`L ${col.x + col.width + 8} (-?[\\d.]+)`).exec(long.path);
    expect(across).not.toBeNull();
    const y = Number(across![1]);
    for (const b of mids) expect(y < b.y || y > b.y + b.height).toBe(true);
  });

  it("labels column groups (e.g. phases) only when their layers do not overlap", () => {
    const nodes = [
      { key: "a", height: 60, column: "CI" },
      { key: "b", height: 60, column: "Dev" },
      { key: "c", height: 60, column: "Dev" },
    ];
    const l = layoutGraph(nodes, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(l.columns.map((c) => c.label)).toEqual(["CI", "Dev"]);
    const mixed = layoutGraph(
      [
        { key: "a", height: 60, column: "CI" },
        { key: "b", height: 60, column: "Dev" },
      ],
      [],
    );
    expect(mixed.columns).toEqual([]);
  });

  it("keeps each column group in its own layer range, without changing any edge", () => {
    // dev-rollback (Dev) and test-deploy (Test) both depend only on dev-smoke, so plain layering puts them
    // side by side; with groups, Test starts after all of Dev.
    const nodes = [
      { key: "dev-deploy", height: 60, column: "Dev" },
      { key: "dev-smoke", height: 60, column: "Dev" },
      { key: "dev-rollback", height: 60, column: "Dev" },
      { key: "test-deploy", height: 60, column: "Test" },
    ];
    const edges = [
      { from: "dev-deploy", to: "dev-smoke" },
      { from: "dev-smoke", to: "dev-rollback" },
      { from: "dev-smoke", to: "test-deploy" },
    ];
    const plain = layoutGraph(nodes.map((n) => ({ key: n.key, height: n.height })), edges);
    expect(plain.boxes.get("test-deploy")!.layer).toBe(plain.boxes.get("dev-rollback")!.layer);
    const grouped = layoutGraph(nodes, edges);
    expect(grouped.boxes.get("test-deploy")!.layer).toBeGreaterThan(grouped.boxes.get("dev-rollback")!.layer);
    expect(grouped.columns.map((c) => c.label)).toEqual(["Dev", "Test"]);
    expect(grouped.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(edges.map((e) => `${e.from}->${e.to}`).sort());
  });

  it("handles a large graph quickly, with no overlapping boxes", () => {
    const nodes: { key: string; height: number }[] = [];
    const edges: { from: string; to: string }[] = [];
    for (let s = 0; s < 12; s++) {
      nodes.push({ key: `gate${s}`, height: 60 });
      for (let j = 0; j < 8; j++) {
        nodes.push({ key: `s${s}j${j}`, height: 60 + (j % 3) * 18 });
        if (s > 0) edges.push({ from: `gate${s - 1}`, to: `s${s}j${j}` });
        edges.push({ from: `s${s}j${j}`, to: `gate${s}` });
      }
    }
    const t0 = performance.now();
    const l = layoutGraph(nodes, edges);
    expect(performance.now() - t0).toBeLessThan(500);
    const boxes = [...l.boxes.values()];
    for (const a of boxes)
      for (const b of boxes) {
        if (a === b || a.layer !== b.layer) continue;
        expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
  });
});
