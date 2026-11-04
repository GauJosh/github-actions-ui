import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMAND_FILE_LIMITS, LOG_BUDGET, LogBudget, Masker, parseFileCommands, readCommandEntries, readPathEntries, validateLogBudget } from "../../deploy/emergency/runner/engine.ts";
import { runChecks } from "../../tools/emergency/runner-check.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("runner file commands", () => {
  it("parses name=value and heredoc entries like GitHub", () => {
    expect(parseFileCommands("a=1\nb<<EOF_X\nline 1\nline=2\nEOF_X\nc=x=y\n")).toEqual({ a: "1", b: "line 1\nline=2", c: "x=y" });
  });
});

// Security review M6: the runner bounds the workflow log output it forwards, so a step can't flood its stdout and push
// the authenticated control events past the executor's log read or out of the kubelet's log, hiding the real result.
describe("log budget (security review M6)", () => {
  it("forwards output within the per-step budget untouched", () => {
    const b = new LogBudget(100, 1000);
    expect(b.take(40)).toEqual({ allow: 40 });
    expect(b.take(60)).toEqual({ allow: 60 });
  });

  it("truncates at the per-step boundary and warns once, then drops the rest of the step", () => {
    const b = new LogBudget(100, 1000);
    expect(b.take(80).allow).toBe(80);
    const cut = b.take(50); // only 20 of the step's budget remains
    expect(cut.allow).toBe(20);
    expect(cut.notice).toMatch(/truncated.*step.*M6/);
    const after = b.take(50); // step budget exhausted
    expect(after.allow).toBe(0);
    expect(after.notice).toBeUndefined(); // warned only once per step
  });

  it("restores the per-step allowance at each step, but not the per-execution total", () => {
    const b = new LogBudget(100, 150);
    expect(b.take(100).allow).toBe(100); // step 1 fills its budget
    b.startStep();
    const step2 = b.take(100); // step 2 has a fresh 100, but only 50 of the execution remains
    expect(step2.allow).toBe(50);
    expect(step2.notice).toBeTruthy();
  });

  it("suppresses all further output once the per-execution budget is spent, with a distinct one-time notice", () => {
    const b = new LogBudget(1000, 100);
    expect(b.take(100).allow).toBe(100);
    b.startStep();
    const over = b.take(10);
    expect(over.allow).toBe(0);
    expect(over.notice).toMatch(/suppressed.*execution.*M6/);
    b.startStep();
    expect(b.take(10)).toEqual({ allow: 0 }); // no repeat notice
  });
});

// Security review F1: a workflow can flood ::add-mask:: commands; the Masker caps how many distinct values (and how
// many total bytes) it stores, so masking can't be turned into unbounded memory/CPU, and secrets added first stay.
describe("mask registration bounds (security review F1)", () => {
  it("masks a registered value and its Base64 encodings", () => {
    const m = new Masker();
    expect(m.add("super-secret-value-123")).toBe(true);
    expect(m.apply("here: super-secret-value-123 end")).toBe("here: *** end");
    expect(m.apply(`b64: ${Buffer.from("super-secret-value-123", "utf8").toString("base64")}`)).toBe("b64: ***");
  });

  it("stops registering once the entry cap is reached, without crowding out the secret added first", () => {
    const m = new Masker();
    expect(m.add("the-real-secret-abcdefgh")).toBe(true); // added first, like a bound Secret
    let rejected = false;
    for (let i = 0; i < 5000 && !rejected; i++) rejected = !m.add(`workflow-add-mask-value-${i}`);
    expect(rejected).toBe(true); // the flood eventually hits the registration cap
    expect(m.apply("x the-real-secret-abcdefgh x")).toBe("x *** x"); // the secret is still masked
  });

  it("bounds total stored mask bytes (large values hit the byte cap)", () => {
    const m = new Masker();
    let rejected = false;
    for (let i = 0; i < 100 && !rejected; i++) rejected = !m.add(`v${i}`.padEnd(20 * 1024, "z"));
    expect(rejected).toBe(true); // 100 × ~20 KiB ≫ the 256 KiB byte cap
  });
});

// Security review F4: the log-budget sizes are validated at startup and the runner/executor fail closed on a bad one,
// so a malformed value can never disable the per-line buffer bound or the log limits.
describe("log budget configuration validation (security review F4)", () => {
  const ok = LOG_BUDGET.defaultStepBytes;
  it("accepts whole-byte budgets within range, including the bounds and the defaults", () => {
    expect(() => validateLogBudget(LOG_BUDGET.defaultStepBytes, LOG_BUDGET.defaultExecutionBytes)).not.toThrow();
    expect(() => validateLogBudget(LOG_BUDGET.minBytes, LOG_BUDGET.maxBytes)).not.toThrow();
  });
  it("rejects NaN, Infinity, zero, negative, fractional and oversized values (fail closed)", () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -1, 1.5, LOG_BUDGET.minBytes - 1, LOG_BUDGET.maxBytes + 1]) {
      expect(() => validateLogBudget(bad, ok), `maxStepLogBytes=${bad}`).toThrow(/F4/);
      expect(() => validateLogBudget(ok, bad), `maxLogBytes=${bad}`).toThrow(/F4/);
    }
  });
});

// Security review F2: $GITHUB_OUTPUT/$GITHUB_ENV/$GITHUB_STATE (readCommandEntries) and $GITHUB_PATH (readPathEntries)
// are read under strict caps — never whole — so a huge file can't exhaust memory or inflate the control events.
describe("workflow command file bounds (security review F2)", () => {
  const withFile = (content: string, fn: (p: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "gha-cmdfile-"));
    try {
      const p = join(dir, "f");
      writeFileSync(p, content);
      fn(p);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("parses a small command file exactly, with no warning", () => {
    withFile("a=1\nb<<EOF\ntwo\nEOF\n", (p) => {
      const r = readCommandEntries(p, "GITHUB_OUTPUT");
      expect(r.entries).toEqual({ a: "1", b: "two" });
      expect(r.warning).toBeUndefined();
    });
  });

  it("truncates an oversized individual entry and warns once", () => {
    withFile(`big=${"y".repeat(200 * 1024)}\n`, (p) => {
      const r = readCommandEntries(p, "GITHUB_OUTPUT");
      expect(r.entries.big!.length).toBe(COMMAND_FILE_LIMITS.maxEntryBytes);
      expect(r.warning).toMatch(/over 65536 bytes; truncated/);
    });
  });

  it("drops entries beyond the count cap and warns", () => {
    const lines = Array.from({ length: COMMAND_FILE_LIMITS.maxEntries + 500 }, (_, i) => `k${i}=v`).join("\n");
    withFile(lines + "\n", (p) => {
      const r = readCommandEntries(p, "GITHUB_ENV");
      expect(Object.keys(r.entries).length).toBe(COMMAND_FILE_LIMITS.maxEntries);
      expect(r.warning).toMatch(/more than 2048 entries/);
    });
  });

  it("reads at most the file-size cap from a huge file, never loading it whole, and warns", () => {
    const huge = `big<<EOF\n${"z".repeat(3 * 1024 * 1024)}\nEOF\n`; // a single value far larger than the whole-file cap
    withFile(huge, (p) => {
      const r = readCommandEntries(p, "GITHUB_STATE");
      expect(r.entries.big!.length).toBeLessThanOrEqual(COMMAND_FILE_LIMITS.maxEntryBytes);
      expect(r.warning).toMatch(/over 1048576 bytes/);
    });
  });

  it("bounds GITHUB_PATH entry count and length", () => {
    const paths = ["a".repeat(100), "b".repeat(100), "x".repeat(200 * 1024)].join("\n");
    withFile(paths + "\n", (p) => {
      const r = readPathEntries(p);
      expect(r.paths).toContain("a".repeat(100));
      expect(r.paths.every((e) => e.length <= COMMAND_FILE_LIMITS.maxEntryBytes)).toBe(true);
      expect(r.warning).toMatch(/over 65536 bytes; skipped/);
    });
  });
});

// Executes the demo pipeline with real bash, python3 and node. The runner image is Linux; on Windows run
// `node tools/emergency/runner-check.ts` in the runner image instead (docs/EMERGENCY_EXECUTION.md).
describe.skipIf(process.platform === "win32")("runner on the demo pipeline", () => {
  it("runs every supported step in order, handles failures, and never leaks the secret", async () => {
    const scenarios = await runChecks(root);
    expect(scenarios.map((s) => [s.name, s.failures])).toEqual(scenarios.map((s) => [s.name, []]));
  }, 120_000);
});
