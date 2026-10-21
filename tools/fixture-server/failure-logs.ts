// SYNTHETIC failure output used by unit and browser tests of failure detection (docs/ARCHITECTURE.md §8.1).
// Test infrastructure only: never imported by the app, so it is not in any build. The formats follow what the
// tools print; the names, paths and messages are invented.
import type { LineKind } from "../../src/domain/logs/classify";

const stamp = (i: number) => `2026-10-21T09:12:${String(10 + Math.floor(i / 100)).padStart(2, "0")}.${String(i % 100).padStart(2, "0")}00000Z `;

/**
 * A job whose JavaScript action crashes because a package is missing. The action's process exits non-zero without
 * an `##[error]` annotation, so the only evidence is Node's own error report: the pattern that was missed.
 */
export const NODE_ACTION_JOB = [
  "Current runner version: '2.337.0'", // 0
  "##[group]Runner Image Provisioner",
  "Hosted Compute Agent",
  "##[endgroup]",
  "Secret source: Actions",
  "Prepare workflow directory", // 5
  "Complete job name: release",
  "##[group]Run actions/checkout@v4",
  "with:",
  "  repository: example/notes-tool",
  "##[endgroup]", // 10
  "Syncing repository: example/notes-tool",
  "##[group]Run example/publish-notes@v1",
  "with:",
  "  channel: beta",
  "##[endgroup]", // 15
  "node:internal/modules/esm/resolve:873",
  "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
  "        ^",
  "",
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@actions/core' imported from /home/runner/work/_actions/example/publish-notes/v1/dist/index.js", // 20
  "    at packageResolve (node:internal/modules/esm/resolve:873:9)",
  "    at moduleResolve (node:internal/modules/esm/resolve:946:18)",
  "    at defaultResolve (node:internal/modules/esm/resolve:1188:11)",
  "    at ModuleLoader.resolve (node:internal/modules/esm/loader:642:12) {",
  "  code: 'ERR_MODULE_NOT_FOUND'", // 25
  "}",
  "",
  "Node.js v20.19.0",
  "Post job cleanup.",
  "[command]/usr/bin/git version", // 30
  "git version 2.55.0",
  "Cleaning up orphan processes",
].map((l, i) => stamp(i) + l);

/** GitHub's step list for NODE_ACTION_JOB: step 3 failed, step 4 was skipped. */
export const NODE_ACTION_STEPS = [
  ["Set up job", "success"],
  ["Run actions/checkout@v4", "success"],
  ["Run example/publish-notes@v1", "failure"],
  ["Run npm run deploy", "skipped"],
  ["Post Run actions/checkout@v4", "success"],
  ["Complete job", "success"],
] as const;

/** Each case: output lines, and the kind expected for some of them (by index). */
export type SignatureCase = { name: string; lines: string[]; kinds: [number, LineKind][] };

export const SIGNATURE_CASES: SignatureCase[] = [
  {
    name: "Node.js CommonJS missing module, confirmed by its stack trace",
    lines: ["Error: Cannot find module 'left-pad'", "Require stack:", "- /home/runner/work/app/app/index.js", "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)", "    at Module._load (node:internal/modules/cjs/loader:1051:27) {", "  code: 'MODULE_NOT_FOUND',", "  requireStack: [ '/home/runner/work/app/app/index.js' ]", "}"],
    kinds: [[0, "error-signature"], [1, "output"], [3, "stack"], [4, "stack"], [5, "stack"], [6, "stack"], [7, "stack"]],
  },
  {
    name: "Node.js TypeError with an async frame",
    lines: ["TypeError: Cannot read properties of undefined (reading 'id')", "    at run (/home/runner/work/app/app/src/main.js:12:20)", "    at async Promise.all (index 0)"],
    kinds: [[0, "error-signature"], [1, "stack"], [2, "stack"]],
  },
  {
    name: "Python traceback ending in its exception",
    lines: ["Traceback (most recent call last):", '  File "/home/runner/work/app/app/main.py", line 8, in <module>', "    main()", '  File "/home/runner/work/app/app/main.py", line 5, in main', '    raise ValueError("unsupported region: moon")', "ValueError: unsupported region: moon", "after the traceback"],
    kinds: [[0, "stack"], [1, "stack"], [2, "stack"], [4, "stack"], [5, "error-signature"], [6, "output"]],
  },
  {
    name: "Python exception without a message, after a traceback",
    lines: ["Traceback (most recent call last):", '  File "/app/run.py", line 2, in <module>', "KeyboardInterrupt"],
    kinds: [[0, "stack"], [1, "stack"], [2, "error-signature"]],
  },
  {
    name: "uncaught Java exception with a cause",
    lines: ['Exception in thread "main" java.lang.IllegalStateException: config missing', "\tat com.example.App.load(App.java:42)", "\tat com.example.App.main(App.java:10)", "Caused by: java.io.FileNotFoundException: app.yaml", "\t... 2 more"],
    kinds: [[0, "error-signature"], [1, "stack"], [2, "stack"], [3, "stack"], [4, "stack"]],
  },
  {
    name: "JVM exception printed by a framework",
    lines: ["org.example.deploy.DeploymentException: target not reachable", "\tat org.example.deploy.Client.send(Client.java:88)"],
    kinds: [[0, "error-signature"], [1, "stack"]],
  },
  {
    name: "shell failures",
    lines: ["/home/runner/work/_temp/0f1e.sh: line 3: kubectlx: command not found", "bash: terraformx: command not found", "make: *** [Makefile:12: build] Error 2", "fatal: not a git repository (or any of the parent directories): .git", "npm error code E404"],
    kinds: [[0, "error-signature"], [1, "error-signature"], [2, "error-signature"], [3, "error-signature"], [4, "error-signature"]],
  },
  {
    name: "compiler, linter and Go failures",
    lines: ["src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", "main.c:10:5: error: expected ';' before 'return'", "error[E0425]: cannot find value `x` in this scope", "  12:5  error  'unused' is assigned a value but never used  no-unused-vars", "panic: runtime error: index out of range [3] with length 3"],
    kinds: [[0, "error-signature"], [1, "error-signature"], [2, "error-signature"], [3, "error-signature"], [4, "error-signature"]],
  },
  {
    name: "test and build failure reports",
    lines: ["FAILED tests/test_api.py::test_create - AssertionError: 500 != 201", "--- FAIL: TestParse (0.00s)", "Tests:       2 failed, 10 passed, 12 total", "[INFO] BUILD FAILURE"],
    kinds: [[0, "test-failed"], [1, "test-failed"], [2, "test-failed"], [3, "test-failed"]],
  },
  {
    name: "heuristic text matches stay heuristic",
    lines: ["error: could not lock config file", "ERROR: failed to push some refs", "[ERROR] Failed to execute goal", 'time=2026-10-21 level=error msg="retrying"', "Error: something went wrong"],
    kinds: [[0, "error-text"], [1, "error-text"], [2, "error-text"], [3, "error-text"], [4, "error-text"]],
  },
  {
    name: "false positives: familiar words, counts and prose",
    lines: [
      "0 errors, 0 warnings",
      "error handling module loaded",
      "Errors are reported to the dashboard; see the error handling guide.",
      "Found 0 errors. Watching for file changes.",
      "The function returns an Error when the input is empty.",
      "  at least 3 replicas are required",
      "Tests:       12 passed, 12 total",
      "warnings: none",
      "TypeErrors are rare in this codebase",
    ],
    kinds: [[0, "output"], [1, "output"], [2, "output"], [3, "output"], [4, "output"], [5, "output"], [6, "test"], [7, "output"], [8, "output"]],
  },
];
