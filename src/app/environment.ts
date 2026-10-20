// Live GitHub or fixture mode. Fixture mode exists only in builds compiled with __FIXTURE_MODE__ (the dev
// server, unit tests and the Playwright test build); production bundles contain none of its code.
// When present it is explicit (`?mode=fixtures`), shows a banner, sends no token, and its transport refuses
// any URL outside the local fixture server, so it can never fall back to GitHub. Live mode never uses it.
import { patProvider } from "../auth/pat-provider";
import type { JobRef } from "../domain/types";
import { createGitHubClient, type GitHubClient } from "../github/client";
import { GITHUB_API, createFixtureTransport, createLiveTransport } from "../github/transport";
import { LogLoader, type LoaderOptions } from "../logs/download/loader";
import { createBrowserWorkerPort } from "../logs/download/worker-session";

export type Mode = "live" | "fixtures";

export type Environment = {
  mode: Mode;
  client: GitHubClient;
  createLoader(ref: JobRef): LogLoader;
};

/**
 * `?mode=fixtures` selects fixture mode where it was compiled in. In other builds it yields an explicit
 * "unavailable" state: never a silent switch to live mode, and no request is made.
 */
export function modeFromLocation(search: string, fixturesCompiledIn: boolean = __FIXTURE_MODE__): Mode | "fixtures-unavailable" {
  if (new URLSearchParams(search).get("mode") !== "fixtures") return "live";
  return fixturesCompiledIn ? "fixtures" : "fixtures-unavailable";
}

function loaderFactory(client: GitHubClient, faults?: LoaderOptions["faults"]) {
  return (ref: JobRef) =>
    new LogLoader({
      request: (method, range, signal) => client.requestJobLog(ref, method, range, signal),
      apiHost: client.apiHost,
      createWorker: createBrowserWorkerPort,
      faults,
    });
}

function liveEnvironment(): Environment {
  const client = createGitHubClient({ apiBase: GITHUB_API, transport: createLiveTransport(patProvider) });
  return { mode: "live", client, createLoader: loaderFactory(client) };
}

export function createEnvironment(mode: Mode, location: Location): Environment {
  if (mode === "live") return liveEnvironment();
  if (!__FIXTURE_MODE__) throw new Error("Fixture mode is not available in this build");
  return fixtureEnvironment(location);
}

// ---- fixture mode (compiled out of production builds) -------------------------------------------

export const FIXTURE_API_PATH = "/__fixtures/api";

/** `fixture-faults=worker-failures-N` fails the first N log workers halfway through the body (A9 tests). */
export function faultsFromLocation(search: string): LoaderOptions["faults"] {
  const match = /^worker-failures-(\d)$/.exec(new URLSearchParams(search).get("fixture-faults") ?? "");
  return match ? { workerFailures: Number(match[1]), atFraction: 0.5 } : undefined;
}

function fixtureEnvironment(location: Location): Environment {
  const apiBase = location.origin + FIXTURE_API_PATH;
  const client = createGitHubClient({ apiBase, transport: createFixtureTransport(apiBase) });
  return { mode: "fixtures", client, createLoader: loaderFactory(client, faultsFromLocation(location.search)) };
}
