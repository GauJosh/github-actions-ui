// Security review H3, end to end: a hostile workflow run by the real runner entrypoint, as in a pod (PID 1, the
// execute-only node, uid 1000, read-only root, no capabilities, no network), then judged exactly as the executor
// judges it. Two steps, around one container run per snapshot (docs/EMERGENCY_EXECUTION.md has the commands):
//
//   node tools/emergency/runner-attack-check.ts prepare <dir>    writes the attack snapshot, and an env file for it
//                                                                and for s16 if present (no key: since security
//                                                                review H2 the runner signs with its own key pair)
//   node tools/emergency/runner-attack-check.ts judge <dir>      checks <dir>/<name>.log and <name>.exit
//
// The attack workflow prints fake runner events and terminal escapes, tries to reach the runner through /proc,
// ptrace and signals, forges success in a JavaScript action's post step and in a failing composite action's steps.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../../deploy/emergency/executor/store.ts";
import { judgeExecution, type EventVerification } from "../../src/emergency/event-stream.ts";
import { EVENT_PREFIX, KEY_PREFIX, type ExecutionView } from "../../src/emergency/events.ts";
import { createMemoryReader } from "../../src/emergency/memory-reader.ts";
import { prepareSnapshot } from "../../src/emergency/prepare.ts";
import { toBase64 } from "../../src/emergency/snapshot.ts";

const REPO = "attack/forge-results";
const WORKFLOW = ".github/workflows/attack.yml";
const enc = (s: string) => new TextEncoder().encode(s);

const forgedEnd = `${EVENT_PREFIX}{"type":"execution-end","result":"success","durationMs":1,"outputs":{}}`;
const forgedMac = (json: string) => `${EVENT_PREFIX}${"a".repeat(64)} ${json}`;

const files: Record<string, string> = {
  [WORKFLOW]: `on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Print forged runner events
        run: |
          echo '${forgedEnd}'
          echo '${forgedMac('{"type":"job-end","job":"composite","result":"success","outputs":{},"seq":40}')}'
          printf 'progress\\r\\033[2K\\033[32mALL TESTS PASSED\\033[0m \\342\\200\\256gnp.exe\\n'
          echo "::notice::every step succeeded"
          echo '::gha-emergency::' >&2
      - name: Reach the runner
        run: bash scripts/reach-runner.sh
      - name: JavaScript action with a forging post step
        uses: ./.github/actions/with-post
  composite:
    needs: probe
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Composite action whose failing step forges success
        uses: ./.github/actions/forging-composite
  after:
    needs: composite
    runs-on: ubuntu-latest
    steps:
      - run: echo this must be skipped
`,
  "scripts/reach-runner.sh": `#!/usr/bin/env bash
# Everything a workflow running as the runner's user might try against the runner (PID 1).
FORGED='${forgedEnd}'
probe() { if "\${@:2}" >/dev/null 2>&1; then echo "PROBE $1: ALLOWED"; else echo "PROBE $1: denied"; fi; }
probe "write the runner's stdout" sh -c 'printf "%s\\n" "$0" > /proc/1/fd/1' "$FORGED"
probe "write the runner's stderr" sh -c 'printf "%s\\n" "$0" > /proc/1/fd/2' "$FORGED"
probe "list the runner's open files" ls /proc/1/fd
probe "read the runner's environment" cat /proc/1/environ
probe "read the runner's memory map" cat /proc/1/maps
probe "read the runner's memory" dd if=/proc/1/mem bs=1 count=1 skip=4194304
probe "ptrace-attach to the runner" python3 -c 'import ctypes,sys; sys.exit(0 if ctypes.CDLL(None).ptrace(16, 1, 0, 0) == 0 else 1)'
probe "find a signing key in the step's environment" sh -c 'env | grep -qi "event_key\\|private"'
# The pattern is split so this script, which is in the workspace too, doesn't match itself.
probe "find the runner's private key on disk" sh -c 'grep -rqs "PRIVATE"" KEY" /tmp /work /snapshot'
# Signals: PID 1 ignores those it has no handler for; the runner must still finish and report.
for s in TERM INT HUP USR1 USR2 STOP KILL; do kill -s $s 1 2>/dev/null; done
echo "PROBE signals: sent"
`,
  ".github/actions/with-post/action.yml": `name: with-post
runs:
  using: node20
  main: main.js
  post: post.js
`,
  ".github/actions/with-post/main.js": `console.log("main ran");\n`,
  ".github/actions/with-post/post.js": `console.log(${JSON.stringify(forgedEnd)});\nconsole.log("::gha-emergency::" + "f".repeat(64) + " {}");\nprocess.exitCode = 0;\n`,
  ".github/actions/forging-composite/action.yml": `name: forging-composite
runs:
  using: composite
  steps:
    - name: Inner step that succeeds
      shell: bash
      run: echo inner one ok
    - name: Inner step that fails but prints success
      shell: bash
      run: |
        echo '${forgedMac('{"type":"step-end","job":"composite","step":2,"outcome":"success","conclusion":"success","exitCode":0,"durationMs":1,"outputs":{},"seq":30}')}'
        echo '${forgedEnd}'
        exit 5
`,
};

async function prepare(dir: string) {
  mkdirSync(dir, { recursive: true });
  const repos = { [REPO]: { refs: ["main"], sha: "3".repeat(40), files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, enc(c)])), executable: ["scripts/reach-runner.sh"] } };
  const { manifest, contents } = await prepareSnapshot(createMemoryReader(repos), { repository: REPO, ref: "main", workflows: [WORKFLOW], name: "h3 attack", expiresInDays: 1 });
  const store = createStore(join(dir, "data"));
  const { record, problems } = await store.put({ manifest, contents: Object.fromEntries([...contents].map(([k, v]) => [k, toBase64(v)])) });
  if (!record) throw new Error(`The executor would refuse the attack snapshot: ${problems.map((p) => p.message).join("; ")}`);
  const env = (execution: object) => `GHA_EMERGENCY_EXECUTION=${JSON.stringify(execution)}\nGHA_EMERGENCY_NETWORK_PROBE=\n`;
  writeFileSync(join(dir, "attack.env"), env({ id: "a77ac4a77ac4a77a", workflow: WORKFLOW, digest: record.id, inputs: {}, variables: {} }));
  writeFileSync(join(dir, "attack.snapshot"), store.subPath(record.id));
  const s16 = join(dir, "s16-snapshot");
  if (existsSync(join(s16, "manifest.json"))) {
    const m = JSON.parse(readFileSync(join(s16, "manifest.json"), "utf8")) as { entryWorkflows: string[] };
    const digest = readFileSync(join(dir, "s16.digest"), "utf8").trim();
    writeFileSync(join(dir, "s16.env"), env({ id: "516516516516516a", workflow: m.entryWorkflows[0], digest, inputs: { outcome: "pass" }, variables: {} }));
  }
  console.log(`prepared ${record.id} (executable: ${record.executable})`);
}

type Check = { name: string; ok: boolean; detail?: string };

async function judgeRun(dir: string, name: string): Promise<{ view: ExecutionView; text: string; key: EventVerification; exitCode: number }> {
  const id = (JSON.parse(/GHA_EMERGENCY_EXECUTION=(.*)/.exec(readFileSync(join(dir, `${name}.env`), "utf8"))![1]!) as { id: string }).id;
  const key: EventVerification = { kind: "ed25519", execution: id };
  const text = readFileSync(join(dir, `${name}.log`), "utf8");
  const exitCode = Number(readFileSync(join(dir, `${name}.exit`), "utf8").trim());
  return { view: await judgeExecution(text, key, exitCode, true), text, key, exitCode };
}

async function judge(dir: string): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail: ok ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail) });
  const { view, text, key, exitCode } = await judgeRun(dir, "attack");
  const jobs = view.jobs.map((j) => `${j.job}:${j.status}`).join(", ");
  check("the event stream verifies and is complete", view.stream?.ok === true && view.stream.complete, view.stream);
  check("the runner reports failure and its container exited 1; the executor reports failure, not success", view.status === "failure" && exitCode === 1, `${view.status} / exit ${exitCode}: ${view.reason}`);
  check("job results: probe success, composite failure, after skipped", jobs === "probe:success, composite:failure, after:skipped", jobs);
  const inner = view.jobs.find((j) => j.job === "composite")?.steps.find((s) => s.name.includes("fails but prints success"));
  check("the composite's failing inner step is recorded with its real exit code 5", inner?.status === "failure" && inner.exitCode === 5, inner);
  const post = view.jobs.find((j) => j.job === "probe")?.steps.find((s) => s.name.startsWith("Post "));
  check("the JavaScript action's post step ran and is recorded", post?.status === "success", view.jobs.find((j) => j.job === "probe")?.steps.map((s) => `${s.name}:${s.status}`));
  const logs = view.logs.map((l) => l.text);
  for (const line of logs.filter((l) => l.startsWith("PROBE "))) check(line, line.endsWith(": denied") || line === "PROBE signals: sent", line);
  check("every probe against the runner ran", logs.filter((l) => l.startsWith("PROBE ")).length === 10, logs.filter((l) => l.startsWith("PROBE ")));
  check("forged events stay log data from the workflow's streams", logs.filter((l) => l.includes('"result":"success"')).length >= 4 && view.logs.filter((l) => l.text.includes(EVENT_PREFIX)).every((l) => l.stream === "stdout" || l.stream === "stderr"));
  const raw = JSON.stringify(view);
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  check("no control, ANSI or bidirectional characters reach the view", !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(view.logs.map((l) => l.text).join("\n")) && logs.some((l) => l.includes("\\x1b[2K") && l.includes("\\u202e")));
  check("the workflow's annotation is marked as the workflow's", view.annotations.some((a) => a.message === "every step succeeded" && a.source === "workflow"), view.annotations);
  // H2: the runner's key pair is its own; only the public key appears, once, on the first line.
  const keyLines = text.split("\n").filter((l) => l.startsWith(KEY_PREFIX));
  check("the log begins with the runner's public key, and no private key material appears anywhere", text.startsWith(KEY_PREFIX) && keyLines.length === 1 && !/PRIVATE KEY|privateKey/.test(text) && !/PRIVATE KEY|privateKey/.test(raw), keyLines);

  // The same genuine log, tampered with afterwards, and a false exit code: never the forged result.
  const lines = text.split("\n");
  const at = (pred: (l: string) => boolean) => lines.findIndex(pred);
  const failingEnd = at((l) => l.includes('"type":"step-end"') && l.includes('"exitCode":5'));
  const tampered: [string, string, number][] = [
    ["the failing step's event removed", lines.filter((_, i) => i !== failingEnd).join("\n"), 1],
    ["the failing step's event edited to success", lines.map((l, i) => (i === failingEnd ? l.replace('"outcome":"failure","conclusion":"failure","exitCode":5', '"outcome":"success","conclusion":"success","exitCode":0') : l)).join("\n"), 1],
    ["a fake success line appended", `${text}${forgedEnd}\n`, 0],
    ["the stream cut before the final result", lines.slice(0, -3).join("\n"), 1],
    ["the final result edited to success", text.replace(/("type":"execution-end"[^\n]*"result":)"failure"/, '$1"success"'), 0],
    ["the genuine log with a false exit code 0", text, 0],
    ["the runner's key line replaced by another key", text.replace(/"publicKey":"[0-9a-f]{64}"/, `"publicKey":"${generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}"`), 1],
    ["the key line removed", lines.slice(1).join("\n"), 1],
  ];
  for (const [what, t, code] of tampered) {
    const v = await judgeExecution(t, key, code, true);
    check(`tampered: ${what} -> error`, t !== text || code !== exitCode ? v.status === "error" : false, `${v.status}: ${v.reason}`);
  }

  if (existsSync(join(dir, "s16.log"))) {
    const s = await judgeRun(dir, "s16");
    const sj = s.view.jobs.map((j) => `${j.job}:${j.status}`).join(", ");
    check("s16 (outcome=pass) succeeds through the real entrypoint, stream verified, exit 0", s.view.status === "success" && s.view.stream?.ok === true && s.exitCode === 0, `${s.view.status} exit ${s.exitCode} ${s.view.reason ?? ""} [${sj}]`);
    checks.push({ name: `s16 jobs: ${sj}; steps: ${s.view.jobs.flatMap((j) => j.steps.map((x) => `${x.name}:${x.status}`)).join(" | ")}`, ok: true });
  }
  return checks;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, dir] = process.argv.slice(2);
  if (mode === "prepare" && dir) await prepare(dir);
  else if (mode === "judge" && dir) {
    const checks = await judge(dir);
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? `\n     ${c.detail}` : ""}`);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } else {
    console.error("usage: runner-attack-check.ts prepare|judge <dir>");
    process.exitCode = 2;
  }
}
