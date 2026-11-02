// The demo pipeline (examples/emergency-demo and its shared actions) as in-memory repositories, for tests and the
// local snapshot tool. Commit SHAs are fixed test values, not git's.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryRepo } from "../../src/emergency/memory-reader.ts";

export const DEMO_REPO = "emergency-demo/release-pipeline";
export const DEMO_SHA = "1111111111111111111111111111111111111111";
export const SHARED_SHA = "2222222222222222222222222222222222222222";

export function readDir(dir: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const walk = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) files[r] = new Uint8Array(readFileSync(join(abs, e.name)));
    }
  };
  walk(dir, "");
  return files;
}

export function demoRepos(repoRoot: string): Record<string, MemoryRepo> {
  const demo = readDir(join(repoRoot, "examples/emergency-demo"));
  return {
    [DEMO_REPO]: { refs: ["main"], sha: DEMO_SHA, files: demo, executable: Object.keys(demo).filter((p) => p.endsWith(".sh")) },
    "demo-org/shared-actions": { refs: ["v1"], sha: SHARED_SHA, files: readDir(join(repoRoot, "examples/emergency-demo-shared-actions")) },
  };
}
