import { describe, expect, it } from "vitest";
import { createEnvironment, faultsFromLocation, modeFromLocation } from "./environment";

const location = { origin: "http://localhost:5173", search: "?mode=fixtures&fixture-faults=worker-failures-2" } as Location;

describe("mode selection", () => {
  it("selects fixture mode only where it is compiled in", () => {
    expect(modeFromLocation("?mode=fixtures", true)).toBe("fixtures");
    expect(modeFromLocation("", true)).toBe("live");
  });

  it("without fixture mode compiled in, ?mode=fixtures is an explicit unavailable state, never live mode", () => {
    expect(modeFromLocation("?mode=fixtures", false)).toBe("fixtures-unavailable");
    expect(modeFromLocation("?mode=live", false)).toBe("live");
  });
});

describe("environments never cross over", () => {
  it("live mode talks to api.github.com and ignores fault switches", () => {
    const env = createEnvironment("live", location);
    expect(env.mode).toBe("live");
    expect(env.client.apiHost).toBe("api.github.com");
  });

  it("fixture mode talks only to the local fixture API", () => {
    const env = createEnvironment("fixtures", location);
    expect(env.mode).toBe("fixtures");
    expect(env.client.apiHost).toBe("localhost:5173");
  });

  it("parses fault switches (fixture mode only)", () => {
    expect(faultsFromLocation(location.search)).toEqual({ workerFailures: 2, atFraction: 0.5 });
    expect(faultsFromLocation("?fixture-faults=other")).toBeUndefined();
  });
});
