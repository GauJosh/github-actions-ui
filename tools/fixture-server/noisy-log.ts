// SYNTHETIC job log used by unit and browser tests of the log display modes (docs/ARCHITECTURE.md §8.1).
// Test infrastructure only: never imported by the app, so it is not in any build.
export const ESC = String.fromCharCode(27);
export const cyan = (s: string) => `${ESC}[36;1m${s}${ESC}[0m`;
const stamp = (i: number) => `2026-10-20T04:38:${String(10 + Math.floor(i / 100)).padStart(2, "0")}.${String(i % 100).padStart(2, "0")}00000Z `;

/**
 * A SYNTHETIC log in the pattern of a GitHub-hosted runner job: setup preamble with groups, a checkout action with
 * `with:` inputs and nested groups, a custom action whose output matters, a `run:` step with script echo, shell
 * and env, test output, explicit annotations, cleanup. It is not real application output.
 */
export const SAMPLE = [
  "Current runner version: '2.337.0'", // 0
  "##[group]Runner Image Provisioner",
  "Hosted Compute Agent",
  "Version: 20261012.601",
  "##[endgroup]",
  "##[group]GITHUB_TOKEN Permissions", // 5
  "Contents: read",
  "##[endgroup]",
  "Secret source: Actions",
  "Prepare workflow directory",
  "Prepare all required actions", // 10
  "Getting action download info",
  "Download action repository 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' (SHA:3d3c42e5aac5ba805825da76410c181273ba90b1)",
  "Complete job name: build",
  "##[group]Run actions/checkout@v4",
  "with:", // 15
  "  repository: example/app",
  "  token: ***",
  "##[endgroup]",
  "Syncing repository: example/app",
  "##[group]Getting Git version info", // 20
  "Working directory is '/home/runner/work/app/app'",
  "[command]/usr/bin/git version",
  "git version 2.55.0",
  "##[endgroup]",
  "##[group]Run ./.github/actions/deploy-config", // 25
  "with:",
  "  environment: dev",
  "env:",
  "  REGION: west",
  "##[endgroup]", // 30
  "Resolved configuration for dev: 3 services, 2 feature flags",
  "working…",
  "working…",
  "working…",
  "working…", // 35
  "done",
  "##[group]Run npm test",
  cyan("npm test"),
  cyan("echo finished"),
  "shell: /usr/bin/bash -e {0}", // 40
  "env:",
  "  NODE_ENV: test",
  "##[endgroup]",
  "> app@1.0.0 test",
  "PASS src/a.test.ts", // 45
  "FAIL src/b.test.ts",
  "Tests:       1 failed, 4 passed, 5 total",
  "Error: expected 200 but received 503",
  "error handling module loaded; 0 errors so far",
  "warning: the option --legacy is deprecated", // 50
  "##[warning]Node.js 16 actions are deprecated.",
  "##[error]Process completed with exit code 1.",
  "Post job cleanup.",
  "[command]/usr/bin/git config --local --name-only --get-regexp core\\.sshCommand",
  "Cleaning up orphan processes", // 55
  "an unrecognised line that must stay visible",
].map((l, i) => stamp(i) + l);
