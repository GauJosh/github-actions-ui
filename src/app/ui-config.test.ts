// Security review M5: the per-origin role reader. The executor origin is never allowed to hold the GitHub token.
import { afterEach, describe, expect, it } from "vitest";
import { githubAllowedHere, uiConfig } from "./ui-config.ts";

const g = globalThis as { __GHA_UI__?: unknown };
afterEach(() => delete g.__GHA_UI__);

describe("uiConfig", () => {
  it("defaults to bundled (single-origin dev) when nothing is injected", () => {
    expect(uiConfig()).toEqual({ role: "bundled", trustedUiUrl: "" });
    expect(githubAllowedHere()).toBe(true);
  });

  it("reads the injected trusted role and its trusted-UI URL", () => {
    g.__GHA_UI__ = { role: "trusted", trustedUiUrl: "https://gha-ui.example" };
    expect(uiConfig()).toEqual({ role: "trusted", trustedUiUrl: "https://gha-ui.example" });
    expect(githubAllowedHere()).toBe(true);
  });

  it("the executor role may not hold the GitHub token", () => {
    g.__GHA_UI__ = { role: "executor", trustedUiUrl: "https://gha-ui.example" };
    expect(githubAllowedHere()).toBe(false);
    expect(githubAllowedHere("executor")).toBe(false);
  });

  it("falls back to bundled for an unknown or malformed value", () => {
    g.__GHA_UI__ = { role: "something-else" };
    expect(uiConfig()).toEqual({ role: "bundled", trustedUiUrl: "" });
    g.__GHA_UI__ = "not an object";
    expect(uiConfig().role).toBe("bundled");
  });
});
