import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFileCommands } from "../../deploy/emergency/runner/engine.ts";
import { runChecks } from "../../tools/emergency/runner-check.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("runner file commands", () => {
  it("parses name=value and heredoc entries like GitHub", () => {
    expect(parseFileCommands("a=1\nb<<EOF_X\nline 1\nline=2\nEOF_X\nc=x=y\n")).toEqual({ a: "1", b: "line 1\nline=2", c: "x=y" });
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
