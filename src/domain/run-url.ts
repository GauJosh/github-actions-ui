import type { RunRef } from "./types";

const NAME = "[A-Za-z0-9_.-]+";
const RUN_URL = new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/actions/runs/(\\d+)(?:/job/(\\d+))?(?:/attempts/\\d+)?/?(?:[?#].*)?$`);

/** Parses a GitHub Actions run (or job) URL. Returns null for anything else. */
export function parseRunUrl(input: string): (RunRef & { jobId?: number }) | null {
  const m = RUN_URL.exec(input.trim());
  if (!m) return null;
  const ref: RunRef & { jobId?: number } = { owner: m[1]!, repo: m[2]!, runId: Number(m[3]) };
  if (m[4]) ref.jobId = Number(m[4]);
  return ref;
}

/** In-app location, kept in the URL fragment. It never contains credentials. */
export type Route = { run?: RunRef; jobId?: number; line?: number };

export function routeToHash(route: Route): string {
  if (!route.run) return "#/";
  const { owner, repo, runId } = route.run;
  let hash = `#/runs/${owner}/${repo}/${runId}`;
  if (route.jobId !== undefined) {
    hash += `/jobs/${route.jobId}`;
    if (route.line !== undefined) hash += `/L${route.line}`;
  }
  return hash;
}

const HASH = new RegExp(`^#/runs/(${NAME})/(${NAME})/(\\d+)(?:/jobs/(\\d+)(?:/L(\\d+))?)?$`);

export function parseHash(hash: string): Route {
  const m = HASH.exec(hash);
  if (!m) return {};
  const route: Route = { run: { owner: m[1]!, repo: m[2]!, runId: Number(m[3]) } };
  if (m[4]) route.jobId = Number(m[4]);
  if (m[5]) route.line = Number(m[5]);
  return route;
}
