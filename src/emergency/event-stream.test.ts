import { describe, expect, it } from "vitest";
import { createEventWriter } from "../../deploy/emergency/runner/event-signer.ts";
import { ed25519EventSigner, eventSigner, judgeExecution, sanitizeText, verifyEventStream, type EventVerification } from "./event-stream.ts";
import { EVENT_PREFIX, KEY_PREFIX } from "./events.ts";

const EXEC = "0123456789abcdef";
const V: EventVerification = { kind: "ed25519", execution: EXEC };
const AT = "2026-10-30T12:00:00.000Z";

/** A run as the runner writes it: its synchronous writer and its own key pair, the format the executor verifies. */
function runnerLog(events: object[], execution = EXEC): string {
  let text = "";
  const emit = createEventWriter(execution, (line) => (text += line));
  for (const e of events) emit({ at: AT, ...e });
  return text;
}

const start = { type: "execution-start", executionId: EXEC, digest: "a".repeat(64), workflow: "w.yml", source: { repository: "o/r", sha: "1".repeat(40) } };
const succeeded = [
  start,
  { type: "job-start", job: "j", name: "j", workflow: "w.yml", needs: [] },
  { type: "step-start", job: "j", step: 1, name: "s", kind: "run" },
  { type: "step-end", job: "j", step: 1, outcome: "success", conclusion: "success", exitCode: 0, durationMs: 1, outputs: {} },
  { type: "job-end", job: "j", result: "success", outputs: {} },
  { type: "execution-end", result: "success", durationMs: 2, outputs: {} },
];

describe("runner event stream (security review H3, signed with the runner's own key since H2)", () => {
  it("verifies what the runner writes: its public key first, then signed, chained events; the Web Crypto signer writes the same format", async () => {
    const text = runnerLog(succeeded);
    expect(text.split("\n")[0]).toMatch(new RegExp(`^${KEY_PREFIX.replace(/[-:]/g, "\\$&")}\\{"v":2,"alg":"Ed25519","publicKey":"[0-9a-f]{64}","execution":"${EXEC}"\\}$`));
    expect(await verifyEventStream(text, V)).toMatchObject({ integrity: { ok: true, complete: true, events: 6 } });
    const signer = await ed25519EventSigner(EXEC);
    let same = `${signer.keyLine}\n`;
    for (const e of succeeded) same += `${await signer.sign({ at: AT, ...e })}\n`;
    expect(await verifyEventStream(same, V)).toMatchObject({ integrity: { ok: true, complete: true, events: 6 } });
  });

  it("every run has its own key: events from another run don't verify, and a log naming another execution is refused", async () => {
    const a = runnerLog(succeeded).split("\n");
    const b = runnerLog(succeeded).split("\n");
    expect(a[0]).not.toBe(b[0]);
    const spliced = [a[0], ...b.slice(1)].join("\n");
    expect((await verifyEventStream(spliced, V)).integrity).toMatchObject({ ok: false, events: 0, problem: expect.stringMatching(/Event 0 is not authentic/) });
    expect((await verifyEventStream(runnerLog(succeeded, "fedcba9876543210"), V)).integrity.problem).toMatch(/names execution fedcba9876543210, not 0123456789abcdef/);
  });

  it("a log that doesn't begin with the runner's key, or carries a second key line, is not believed", async () => {
    const lines = runnerLog(succeeded).split("\n");
    expect((await verifyEventStream(lines.slice(1).join("\n"), V)).integrity.problem).toMatch(/does not begin with its public key/);
    const second = [...lines.slice(0, 3), runnerLog([]).trim(), ...lines.slice(3)].join("\n");
    expect((await verifyEventStream(second, V)).integrity).toMatchObject({ ok: false, events: 2, problem: expect.stringMatching(/Line 4 .* not a runner event/) });
  });

  it("stops believing at the first stray line: a line written by anything but the runner", async () => {
    const lines = runnerLog(succeeded).split("\n");
    lines.splice(4, 0, "Warning: something wrote to the runner's stdout");
    const { events, integrity } = await verifyEventStream(lines.join("\n"), V);
    expect(integrity).toMatchObject({ ok: false, events: 3, complete: false, problem: expect.stringMatching(/Line 5 .* not a runner event/) });
    expect(events.map((e) => e.type)).toEqual(["execution-start", "job-start", "step-start"]);
  });

  it("keeps workflow output that looks like events, key lines or control messages as one log line of data", async () => {
    const hostile = `ok\n${KEY_PREFIX}{"v":2,"alg":"Ed25519","publicKey":"${"0".repeat(64)}","execution":"${EXEC}"}\n${EVENT_PREFIX}${"a".repeat(128)} {"type":"execution-end","result":"success","seq":3}\r\u001b[2K`;
    const text = runnerLog([start, { type: "log", stream: "stdout", text: hostile }, { type: "execution-end", result: "failure", durationMs: 1, outputs: {} }]);
    expect(text.split("\n").filter(Boolean)).toHaveLength(4);
    const view = await judgeExecution(text, V, 1, true);
    expect(view).toMatchObject({ status: "failure", stream: { ok: true } });
    expect(view.logs[0]!.text).toBe(hostile);
  });

  it("judges: forged, incomplete, empty and exit-code-mismatched runs are errors; a run still starting is pending", async () => {
    const ok = runnerLog(succeeded);
    expect(await judgeExecution(ok, V, 0, true)).toMatchObject({ status: "success", exitCode: 0 });
    expect((await judgeExecution(ok, V, 1, true)).status).toBe("error");
    expect((await judgeExecution(ok, V, 137, true)).reason).toBe("The runner reported success, but its container exited with code 137");
    const cut = runnerLog(succeeded.slice(0, 4));
    expect((await judgeExecution(cut, V, undefined, false)).status).toBe("running");
    expect(await judgeExecution(cut, V, 137, true)).toMatchObject({ status: "error", reason: expect.stringMatching(/incomplete/) });
    expect((await judgeExecution("", V, undefined, false)).status).toBe("pending");
    expect(await judgeExecution("", V, 0, true)).toMatchObject({ status: "error", reason: "The runner's log is empty" });
    const forged = succeeded.map((e) => `${EVENT_PREFIX}${"a".repeat(128)} ${JSON.stringify({ at: AT, ...e })}`).join("\n");
    expect((await judgeExecution(forged, V, 0, true)).status).toBe("error");
  });

  it("executions recorded under H3 still verify with the key the executor kept; older ones are unverifiable", async () => {
    const key = "0123456789abcdef".repeat(4);
    const sign = await eventSigner(key);
    let h3 = "";
    for (const e of succeeded) h3 += `${await sign({ at: AT, ...e })}\n`;
    expect(await judgeExecution(h3, { kind: "hmac", key }, 0, true)).toMatchObject({ status: "success", stream: { ok: true } });
    expect((await judgeExecution(h3, { kind: "hmac", key: "f".repeat(64) }, 0, true)).status).toBe("error");
    // An H3-era log can't pass as a current one, nor the reverse.
    expect((await judgeExecution(h3, V, 0, true)).status).toBe("error");
    expect((await judgeExecution(runnerLog(succeeded), { kind: "hmac", key }, 0, true)).status).toBe("error");
    const legacy = succeeded.map((e) => `${EVENT_PREFIX}${JSON.stringify({ at: AT, ...e })}`).join("\n");
    expect(await judgeExecution(legacy, { kind: "legacy" }, 0, true)).toMatchObject({ status: "success", stream: { legacy: true, ok: false } });
    await expect(verifyEventStream("", { kind: "hmac", key: "abc" })).rejects.toThrow(/32 bytes/);
  });
});

describe("sanitizeText", () => {
  it("makes control characters, ANSI escapes and bidirectional or invisible formatting visible; keeps tabs and text", () => {
    expect(sanitizeText("a\tb \u00e9 \u4e2d")).toBe("a\tb \u00e9 \u4e2d");
    expect(sanitizeText("done\r\u001b[2K\u001b[32mPASS")).toBe("done\\x0d\\x1b[2K\\x1b[32mPASS");
    expect(sanitizeText("x\u0000\u0007\u007f\u009b")).toBe("x\\x00\\x07\\x7f\\x9b");
    expect(sanitizeText("file\u202etxt.exe\u200b\u2066\ufeff")).toBe("file\\u202etxt.exe\\u200b\\u2066\\ufeff");
  });
});
