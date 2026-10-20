import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Job, Step } from "../types";
import { createMarkerScanner, locateStep, mapSteps, targetLine, type LogMarkers } from "./step-map";

const COMMIT = (JSON.parse(readFileSync("fixtures.lock.json", "utf8")) as { commit: string }).commit;
const ROOT = `.fixtures/${COMMIT}/fixtures`;

function scan(text: string): LogMarkers {
  const scanner = createMarkerScanner();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) scanner.push(line.replace(/\r$/, ""));
  return scanner.result();
}

type CorpusJob = { run: string; job: Job; log: string };
function corpus(): CorpusJob[] {
  const out: CorpusJob[] = [];
  for (const repo of readdirSync(ROOT)) {
    for (const run of readdirSync(join(ROOT, repo))) {
      const dir = join(ROOT, repo, run);
      if (!existsSync(join(dir, "attempts"))) continue;
      const attempt = readdirSync(join(dir, "attempts")).map(Number).sort((a, b) => b - a)[0]!;
      const data = JSON.parse(readFileSync(join(dir, "attempts", String(attempt), "jobs.json"), "utf8")) as { jobs: Job[] } | Job[];
      for (const job of Array.isArray(data) ? data : data.jobs) {
        const path = join(dir, "logs", `${job.id}.log.gz`);
        if (existsSync(path) && job.steps?.length) out.push({ run, job, log: gunzipSync(readFileSync(path)).toString("utf8") });
      }
    }
  }
  return out;
}

const step = (number: number, name: string, conclusion: string | null, start: string | null, end: string | null = start): Step =>
  ({ number, name, status: "completed", conclusion, started_at: start, completed_at: end }) as Step;

describe("step mapping v2 on the pinned fixture corpus (consistency checks, not ground truth)", () => {
  const jobs = corpus();

  it("finds the corpus", () => {
    expect(jobs.length).toBeGreaterThanOrEqual(60);
  });

  it("passes every check, with no risk flag, on every real job", () => {
    const failures = jobs
      .map(({ run, job, log }) => ({ run, job: job.id, result: mapSteps(job.steps!, scan(log)) }))
      .filter((r) => r.result.mapping !== "exact-checks-passed")
      .map((r) => `${r.run}/${r.job}: ${r.result.issues.join(" ")}`);
    expect(failures).toEqual([]);
  });

  it("puts every failed step's error lines in that step", () => {
    let failedSteps = 0;
    for (const { job, log } of jobs) {
      const mapping = mapSteps(job.steps!, scan(log));
      for (const s of job.steps!.filter((s) => s.conclusion === "failure")) {
        failedSteps++;
        const where = locateStep(job.steps!, mapping, s.number);
        expect(where.kind).toBe("segment");
        if (where.kind === "segment") expect(where.segment.errorLines.length).toBeGreaterThan(0);
      }
    }
    expect(failedSteps).toBeGreaterThanOrEqual(20);
  });

  describe("s16: a composite action followed by a named step", () => {
    const s16 = jobs.filter((j) => j.run === "39370654036" || j.run === "39370646308");
    const lineOf = (log: string, needle: string) => log.split("\n").findIndex((l) => l.includes(needle)) + 1;

    it("keeps the composite's inner output in the composite step and the error in the step after it", () => {
      expect(s16).toHaveLength(2);
      for (const { job, log } of s16) {
        const mapping = mapSteps(job.steps!, scan(log));
        expect(mapping.mapping).toBe("exact-checks-passed");
        const seg = (name: string) => mapping.segments.find((s) => s.stepNumber === job.steps!.find((x) => x.name === name)!.number)!;
        const composite = seg("Run ./.github/actions/fixture-composite");
        const after = seg("Step after composite");
        const unnamed = seg('Run echo "unnamed final step"');
        for (const inner of ['Run echo "composite step 1 ok"', "config ok"]) {
          const n = lineOf(log, inner);
          expect(n).toBeGreaterThanOrEqual(composite.startLine);
          expect(n).toBeLessThanOrEqual(composite.endLine);
        }
        expect(lineOf(log, "running the step that follows the composite action")).toBeGreaterThanOrEqual(after.startLine);
        expect(lineOf(log, "unnamed final step") >= unnamed.startLine || lineOf(log, "unnamed final step") <= after.endLine).toBe(true);
        expect(after.endLine).toBeLessThan(unnamed.startLine);
        if (job.conclusion === "failure") {
          expect(after.errorLines.map((n) => log.split("\n")[n - 1])).toEqual([
            expect.stringContaining("##[error]synthetic failure in the step after the composite action"),
            expect.stringContaining("##[error]Process completed with exit code 4."),
          ]);
          expect(targetLine(after, job.steps!.find((s) => s.name === "Step after composite"))).toBe(after.errorLines[0]);
        }
      }
    });

    it("flags copies without start-action/end-action markers as approximate (simulating a runner that does not emit them)", () => {
      for (const { job, log } of s16) {
        const stripped = log
          .split("\n")
          .filter((l) => !/##\[(start|end)-action/.test(l))
          .join("\n");
        const mapping = mapSteps(job.steps!, scan(stripped));
        expect(mapping.mapping).toBe("approximate");
        expect(mapping.issues.join(" ")).toContain("top-level “Run” markers");
      }
    });
  });
});

describe("step mapping v2 rules", () => {
  const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString().replace(".000Z", "Z");
  const L = (s: number, text: string) => `${T(s).replace("Z", ".5000000Z")} ${text}`;
  const steps = [
    step(1, "Set up job", "success", T(0), T(1)),
    step(2, "Build", "success", T(1), T(3)),
    step(3, "Test", "failure", T(3), T(5)),
    step(4, "Deploy", "skipped", null),
    step(5, "Complete job", "success", T(5), T(5)),
  ];
  const log = [
    L(0, "Current runner version: '2.337.0'"),
    L(1, "##[group]Run make build"),
    L(1, "##[endgroup]"),
    L(2, "built"),
    L(3, "##[group]Run make test"),
    L(3, "##[endgroup]"),
    L(4, "1 test failed"),
    L(4, "##[error]Process completed with exit code 2."),
    L(5, "Cleaning up orphan processes"),
  ].join("\n");

  it("maps each executed step to its lines, and a failed step to its first error line", () => {
    const mapping = mapSteps(steps, scan(log));
    expect(mapping).toMatchObject({ mapping: "exact-checks-passed", issues: [] });
    expect(mapping.segments.map((s) => [s.stepNumber, s.startLine, s.endLine])).toEqual([
      [1, 1, 1],
      [2, 2, 4],
      [3, 5, 8],
      [5, 9, 9],
    ]);
    const where = locateStep(steps, mapping, 3);
    expect(where.kind === "segment" && targetLine(where.segment, steps[2])).toBe(8);
    const ok = locateStep(steps, mapping, 2);
    expect(ok.kind === "segment" && targetLine(ok.segment, steps[1])).toBe(2);
  });

  it("gives skipped steps no lines", () => {
    expect(locateStep(steps, mapSteps(steps, scan(log)), 4)).toEqual({ kind: "no-output", reason: "skipped" });
  });

  it("never attributes lines to a step whose marker is missing", () => {
    const missing = log.replace(L(3, "##[group]Run make test"), L(3, "make test"));
    const mapping = mapSteps(steps, scan(missing));
    expect(mapping.mapping).toBe("approximate");
    expect(locateStep(steps, mapping, 3)).toMatchObject({ kind: "unmatched" });
    expect(mapping.issues.join(" ")).toContain("No log marker was found for step 3");
  });

  it("is approximate when an error line falls in a step that succeeded", () => {
    const leaked = log.replace(L(2, "built"), L(2, "##[error]warning promoted to error"));
    const mapping = mapSteps(steps, scan(leaked));
    expect(mapping.mapping).toBe("approximate");
    expect(mapping.issues).toContain("An error line falls in step 2, which succeeded.");
  });

  it("is approximate when a marker is outside the step's time window", () => {
    const late = log.replace(L(1, "##[group]Run make build"), L(9, "##[group]Run make build"));
    expect(mapSteps(steps, scan(late)).issues.join(" ")).toContain("outside the step's reported start and end times");
  });

  it("prefers the marker with the step's exact name when there are extra Run markers, and flags the risk", () => {
    const named = [step(1, "Set up job", "success", T(0), T(1)), step(2, "Run ./deploy.sh", "success", T(1), T(4)), step(3, "Complete job", "success", T(4), T(4))];
    const extra = [L(0, "setup"), L(1, "##[group]Run helper"), L(1, "##[endgroup]"), L(2, "##[group]Run ./deploy.sh"), L(2, "##[endgroup]"), L(4, "Cleaning up orphan processes")].join("\n");
    const mapping = mapSteps(named, scan(extra));
    expect(mapping.mapping).toBe("approximate");
    expect(mapping.segments.find((s) => s.stepNumber === 2)!.startLine).toBe(4);
  });

  it("is unavailable for an empty log", () => {
    expect(mapSteps(steps, scan("")).mapping).toBe("unavailable");
  });
});
