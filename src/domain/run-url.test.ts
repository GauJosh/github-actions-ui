import { describe, expect, it } from "vitest";
import { parseHash, parseRunUrl, routeToHash } from "./run-url";

describe("parseRunUrl", () => {
  it("parses run, job and attempt URLs", () => {
    expect(parseRunUrl("https://github.com/GauJosh/gha-ui-fixtures/actions/runs/39366140909")).toEqual({
      owner: "GauJosh",
      repo: "gha-ui-fixtures",
      runId: 39366140909,
    });
    expect(parseRunUrl(" https://github.com/o/r/actions/runs/1/job/2?pr=3 ")).toEqual({ owner: "o", repo: "r", runId: 1, jobId: 2 });
    expect(parseRunUrl("https://github.com/o/r/actions/runs/1/attempts/2")).toEqual({ owner: "o", repo: "r", runId: 1 });
  });

  it("rejects other URLs", () => {
    for (const url of ["https://example.com/o/r/actions/runs/1", "https://github.com/o/r/pull/1", "javascript:alert(1)", ""]) {
      expect(parseRunUrl(url)).toBeNull();
    }
  });
});

describe("hash routes", () => {
  it("round-trips run, job and line", () => {
    const route = { run: { owner: "o", repo: "r", runId: 1 }, jobId: 2, line: 215057 };
    expect(routeToHash(route)).toBe("#/runs/o/r/1/jobs/2/L215057");
    expect(parseHash(routeToHash(route))).toEqual(route);
    expect(parseHash("#/nonsense")).toEqual({});
  });
});
