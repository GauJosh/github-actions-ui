// End-to-end check of the emergency runner on the demo pipeline, without Kubernetes or GitHub: prepare a snapshot
// (in-memory reader), store it like the executor does, run it with the runner engine, and assert on the events.
// Needs bash, python3 and node (the runner image has them). Used by tests (Linux) and run directly in the runner
// image with networking disabled:
//
//   node tools/emergency/runner-check.ts            prints a report; exit code 1 on any failed expectation
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_FILE_LIMITS, runSnapshot } from "../../deploy/emergency/runner/engine.ts";
import { createStore } from "../../deploy/emergency/executor/store.ts";
import { summarize, type ExecutionView, type RunnerEvent } from "../../src/emergency/events.ts";
import { createMemoryReader, type MemoryRepo } from "../../src/emergency/memory-reader.ts";
import { prepareSnapshot } from "../../src/emergency/prepare.ts";
import { manifestDigest, toBase64 } from "../../src/emergency/snapshot.ts";
import { DEMO_REPO, demoRepos } from "./demo-repos.ts";

export const SECRET = "demo-signing-key-7f3a91c2";

export type Scenario = { name: string; view: ExecutionView; events: RunnerEvent[]; result: string; failures: string[] };

async function execute(repoRoot: string, repos: Record<string, MemoryRepo>, opts: { secret?: string; tamper?: boolean; inputs?: Record<string, string>; extraSecrets?: Record<string, string>; forgeStripErrors?: boolean; logCaps?: { perStep: number; total: number } }) {
  const base = mkdtempSync(join(tmpdir(), "gha-emergency-"));
  try {
    const { manifest, contents } = await prepareSnapshot(createMemoryReader(repos), { repository: DEMO_REPO, ref: "main", workflows: [".github/workflows/release.yml"], name: "runner check", expiresInDays: 1 });
    const store = createStore(join(base, "data"));
    let snapshotDir: string;
    let digest: string;
    if (opts.forgeStripErrors) {
      // Security review H1, in depth: a forged manifest (errors stripped) written straight into storage, as a
      // compromised executor could. The executor would refuse the upload; the runner must refuse it too.
      const forged = { ...manifest, diagnostics: [] };
      digest = await manifestDigest(forged);
      snapshotDir = join(store.dataDir, store.subPath(digest));
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(join(snapshotDir, "manifest.json"), JSON.stringify(forged));
      for (const f of forged.files) {
        const target = join(snapshotDir, "files", ...f.root.split("/"), ...f.path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents.get(f.sha256)!);
      }
    } else {
      const bundle = { manifest, contents: Object.fromEntries([...contents].map(([k, v]) => [k, toBase64(v)])) };
      const { record, problems } = await store.put(bundle);
      if (!record) throw new Error(`Store refused the snapshot: ${problems.map((p) => p.message).join("; ")}`);
      snapshotDir = join(store.dataDir, store.subPath(record.id));
      digest = record.id;
    }
    if (opts.tamper) {
      const target = join(snapshotDir, "files", "workspace", "scripts", "build.sh");
      chmodSync(join(snapshotDir, "files", "workspace", "scripts"), 0o755);
      chmodSync(target, 0o644);
      writeFileSync(target, "echo tampered\n");
    }
    const secretsDir = join(base, "secrets");
    mkdirSync(secretsDir);
    if (opts.secret !== undefined) writeFileSync(join(secretsDir, "DEMO_SIGNING_KEY"), opts.secret);
    for (const [k, v] of Object.entries(opts.extraSecrets ?? {})) writeFileSync(join(secretsDir, k), v);
    const events: RunnerEvent[] = [];
    const result = await runSnapshot({
      snapshotDir,
      workDir: join(base, "work"),
      secretsDir,
      execution: { id: "0123456789abcdef", workflow: ".github/workflows/release.yml", digest, inputs: opts.inputs ?? { version: "2.0.1" }, variables: {} },
      emit: (e) => events.push(JSON.parse(JSON.stringify(e)) as RunnerEvent),
      maxMinutes: 5,
      maxStepLogBytes: opts.logCaps?.perStep,
      maxLogBytes: opts.logCaps?.total,
      networkProbe: [],
    });
    return { result, events, view: summarize(events) };
  } finally {
    const unlock = (d: string) => {
      try {
        chmodSync(d, 0o755);
        for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(join(d, e.name));
      } catch {
        // best effort
      }
    };
    unlock(base);
    rmSync(base, { recursive: true, force: true });
  }
}

export async function runChecks(repoRoot: string): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  const check = (s: Scenario, ok: boolean, what: string) => {
    if (!ok) s.failures.push(what);
  };

  {
    const r = await execute(repoRoot, demoRepos(repoRoot), { secret: SECRET });
    const s: Scenario = { name: "demo pipeline succeeds in dependency order", ...r, failures: [] };
    const jobs = s.view.jobs.map((j) => `${j.job}:${j.status}`);
    check(s, s.result === "success", `result success (got ${s.result}: ${s.view.reason ?? ""})`);
    check(s, JSON.stringify(jobs) === JSON.stringify(["prepare:success", "build:success", "build/compile:success", "build/package:success", "report:success"]), `job order and results (got ${jobs.join(", ")})`);
    const compile = s.view.jobs.find((j) => j.job === "build/compile");
    check(s, compile?.steps.map((x) => x.status).join(",") === "success,success,success,success", `compile steps all succeed (got ${compile?.steps.map((x) => `${x.name}:${x.status}:${x.reason ?? ""}`).join(" | ")})`);
    const stamp = s.view.jobs.find((j) => j.job === "build")?.outputs.stamp ?? "";
    check(s, /^2\.0\.1\+[0-9a-f]{12}$/.test(stamp), `reusable workflow output stamp (got ${stamp})`);
    const checksum = s.view.jobs.find((j) => j.job === "build")?.outputs.checksum ?? "";
    check(s, /^[0-9a-f]{16}$/.test(checksum), `reusable workflow output checksum (got ${checksum})`);
    const text = s.view.logs.map((l) => l.text).join("\n");
    check(s, text.includes("Stamped 2.0.1 as") && text.includes("Verified checksum") && text.includes("Compiled build/app.txt"), "logs from the JavaScript action and both scripts");
    check(s, s.view.annotations.some((a) => a.level === "notice" && a.message.includes("Built 2.0.1")), "notice annotation from the external action");
    check(s, text.includes(`version=2.0.1 checksum=${checksum} stamp=${stamp}`), "composite action used outputs of earlier jobs");
    check(s, !JSON.stringify(s.events).includes(SECRET), "secret value never appears in any event");
    scenarios.push(s);
  }
  {
    const r = await execute(repoRoot, demoRepos(repoRoot), {});
    const s: Scenario = { name: "missing secret stops before any job", ...r, failures: [] };
    check(s, s.result === "failure" && /DEMO_SIGNING_KEY/.test(s.view.reason ?? "") && s.view.jobs.length === 0, `refused (got ${s.result}: ${s.view.reason})`);
    scenarios.push(s);
  }
  {
    // Security review C1, demonstrated attack: a key the snapshot never references was mounted next to the required
    // one, and a step read it from /secrets. The runner now refuses before any job, and never emits the value.
    const r = await execute(repoRoot, demoRepos(repoRoot), { secret: SECRET, extraSecrets: { OTHER_TEAM_TOKEN: "other-team-token-ZZZ" } });
    const s: Scenario = { name: "a mounted Secret key the snapshot doesn't require stops the run (review C1)", ...r, failures: [] };
    check(s, s.result === "failure" && s.view.jobs.length === 0, `refused before any job (got ${s.result}, ${s.view.jobs.length} jobs)`);
    check(s, /OTHER_TEAM_TOKEN/.test(s.view.reason ?? "") && /does not require/.test(s.view.reason ?? ""), `reason names the unexpected key (got ${s.view.reason})`);
    check(s, !JSON.stringify(s.events).includes("other-team-token-ZZZ") && !JSON.stringify(s.events).includes("ZZZ-nekot-maet-rehto"), "the unexpected key's value is never emitted");
    scenarios.push(s);
  }
  {
    // A workflow the validator refuses (github.token), with its errors stripped from the manifest.
    const repos = demoRepos(repoRoot);
    repos[DEMO_REPO]!.files[".github/workflows/release.yml"] = "on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo leak ${{ github.token }}\n";
    const r = await execute(repoRoot, repos, { secret: SECRET, forgeStripErrors: true });
    const s: Scenario = { name: "a forged manifest written straight to storage is refused by the runner (review H1)", ...r, failures: [] };
    check(s, s.result === "failure" && s.view.jobs.length === 0, `refused before any job (got ${s.result}, ${s.view.jobs.length} jobs)`);
    check(s, s.view.verified?.ok === false && (s.view.verified.problems.join(" ").includes("under-reports validation errors")), `verification names the under-reported errors (got ${JSON.stringify(s.view.verified)})`);
    scenarios.push(s);
  }
  {
    const r = await execute(repoRoot, demoRepos(repoRoot), { secret: SECRET, tamper: true });
    const s: Scenario = { name: "tampered snapshot is refused", ...r, failures: [] };
    check(s, s.result === "failure" && s.view.verified?.ok === false && s.view.jobs.length === 0, `verification failed (got ${JSON.stringify(s.view.verified)})`);
    scenarios.push(s);
  }
  {
    const repos = demoRepos(repoRoot);
    repos[DEMO_REPO]!.files["scripts/verify.sh"] = "#!/usr/bin/env bash\necho '::error::verification failed on purpose'\nexit 3\n";
    const r = await execute(repoRoot, repos, { secret: SECRET });
    const s: Scenario = { name: "a failing step fails its job; dependents are skipped", ...r, failures: [] };
    const jobs = s.view.jobs.map((j) => `${j.job}:${j.status}`);
    check(s, s.result === "failure", "result failure");
    check(s, JSON.stringify(jobs) === JSON.stringify(["prepare:success", "build:failure", "build/compile:success", "build/package:failure", "report:skipped"]), `job results (got ${jobs.join(", ")})`);
    const verify = s.view.jobs.find((j) => j.job === "build/package")?.steps.at(-1);
    check(s, verify?.exitCode === 3 && verify.status === "failure", `exit code 3 recorded (got ${verify?.exitCode})`);
    scenarios.push(s);
  }
  {
    // Security review M1: workflow-controlled values (a step's output, a dispatch input) reach later scripts. They
    // must stay data, never shell syntax. The value is inert: if it were ever executed it would print M1_EXEC on its
    // own line; as data it is only ever printed inside a labelled line. Also: deprecated ::set-output:: is ignored.
    const repos = demoRepos(repoRoot);
    repos[DEMO_REPO]!.files[".github/workflows/release.yml"] = M1_WORKFLOW;
    const r = await execute(repoRoot, repos, { inputs: { version: M1_INPUT } });
    const s: Scenario = { name: "workflow-controlled values stay data in later scripts (review M1)", ...r, failures: [] };
    const lines = s.view.logs.map((l) => l.text);
    const steps = s.view.jobs[0]?.steps ?? [];
    check(s, s.result === "success", `result success (got ${s.result}: ${s.view.reason ?? ""})`);
    // The inert payload never executed: these markers only appear on their own line if a value became a command.
    check(s, !lines.includes("M1_EXEC"), `shell payload never executed (unexpected lines: ${JSON.stringify(lines.filter((l) => l === "M1_EXEC"))})`);
    check(s, !lines.includes("M1_INPUT_EXEC"), "dispatch-input payload never executed");
    // The value is printed literally as data in every shell quoting context, and from Python via env:.
    for (const prefix of ["dq", "sq", "uq", "py"]) check(s, lines.includes(`${prefix}: ${M1_VALUE}`), `${prefix} printed the value literally (got ${JSON.stringify(lines.filter((l) => l.startsWith(`${prefix}: `)))})`);
    check(s, lines.includes(`inp: ${M1_INPUT}`), `dispatch input printed literally (got ${JSON.stringify(lines.filter((l) => l.startsWith("inp: ")))})`);
    // Deprecated ::set-output:: on stdout set no output and is only visible as log data, with a runner warning.
    const tool = steps.find((x) => x.name === "tool");
    check(s, tool?.outputs.v === M1_VALUE, `GITHUB_OUTPUT still works (got ${JSON.stringify(tool?.outputs)})`);
    check(s, tool?.outputs.forged === undefined, "::set-output:: on stdout set no output");
    check(s, lines.some((l) => l.includes("::set-output name=forged")), "the ignored ::set-output:: line is kept as log data");
    check(s, s.view.annotations.some((a) => a.source === "runner" && /set-output.*deprecated|deprecated.*ignored/.test(a.message)), `a runner warning records the ignored command (got ${JSON.stringify(s.view.annotations)})`);
    scenarios.push(s);
  }
  {
    // Security review M2: a workflow re-encodes its secret to dodge exact-match masking. The runner now masks the
    // value and its standard and URL-safe Base64 forms everywhere it emits: stdout, stderr, step outputs, annotations.
    const repos = demoRepos(repoRoot);
    repos[DEMO_REPO]!.files[".github/workflows/release.yml"] = M2_WORKFLOW;
    const r = await execute(repoRoot, repos, { secret: SECRET });
    const s: Scenario = { name: "secret and its Base64 encodings are masked everywhere (review M2)", ...r, failures: [] };
    const std = Buffer.from(SECRET, "utf8").toString("base64");
    const url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const everywhere = JSON.stringify(s.events);
    check(s, s.result === "success", `result success (got ${s.result}: ${s.view.reason ?? ""})`);
    for (const [what, form] of [["raw value", SECRET], ["standard base64", std], ["url-safe base64", url]] as const) check(s, !everywhere.includes(form), `${what} never appears in any event`);
    const lines = s.view.logs.map((l) => l.text);
    check(s, lines.includes("BEGIN") && lines.includes("END"), "non-secret output stays readable");
    check(s, lines.some((l) => l === "raw: ***") && lines.some((l) => l === "std: ***") && lines.some((l) => l === "url: ***"), `stdout masked (got ${JSON.stringify(lines.filter((l) => /^(raw|std|url):/.test(l)))})`);
    check(s, s.view.logs.some((l) => l.stream === "stderr" && l.text === "err: ***"), "stderr masked");
    const enc = s.view.jobs[0]?.steps.find((x) => x.name === "encode");
    check(s, enc?.outputs.leaked === "***" && enc.outputs.stdb64 === "***", `step outputs masked (got ${JSON.stringify(enc?.outputs)})`);
    check(s, s.view.annotations.some((a) => a.message === "annotated ***"), `annotation masked (got ${JSON.stringify(s.view.annotations.map((a) => a.message))})`);
    scenarios.push(s);
  }
  {
    // Security review M6: a step floods its stdout to hide the real result. The runner caps the workflow log output it
    // forwards per step and per execution, so the flood is truncated (with a runner notice), a later step still logs,
    // and the final result is recorded. Small caps here keep the check fast; the defaults are 1 MiB / 4 MiB.
    const repos = demoRepos(repoRoot);
    repos[DEMO_REPO]!.files[".github/workflows/release.yml"] = M6_WORKFLOW;
    const r = await execute(repoRoot, repos, { logCaps: { perStep: 2000, total: 8000 } });
    const s: Scenario = { name: "a log flood is capped; the result and later steps survive (review M6)", ...r, failures: [] };
    const lines = s.view.logs.map((l) => l.text);
    const floodLines = lines.filter((l) => l.startsWith("FLOOD-"));
    const floodChars = floodLines.reduce((n, l) => n + l.length, 0);
    check(s, s.result === "success", `result success (got ${s.result}: ${s.view.reason ?? ""})`);
    check(s, s.events.at(-1)?.type === "execution-end", `the final result is still recorded (last event ${s.events.at(-1)?.type})`);
    check(s, floodLines.length < 500 && floodChars <= 2000 + 80, `the flood step's forwarded log is capped (${floodLines.length} lines, ${floodChars} chars)`);
    check(s, s.view.annotations.some((a) => a.source === "runner" && /truncated.*M6/.test(a.message)), `a runner notice records the truncation (got ${JSON.stringify(s.view.annotations.filter((a) => a.source === "runner").map((a) => a.message))})`);
    check(s, lines.includes("AFTER_MARKER"), "a step after the flood still has its output (the per-step budget reset)");
    scenarios.push(s);
  }
  {
    // Security review F1/M6: a step floods ::add-mask:: commands. The acknowledgement lines are now charged to the log
    // budget (so they can't bypass it and crowd out the control events), the mask registry is capped (one warning,
    // then further registrations ignored), and the real result and a later step still come through.
    const repos = demoRepos(repoRoot);
    repos[DEMO_REPO]!.files[".github/workflows/release.yml"] = F1_WORKFLOW;
    const r = await execute(repoRoot, repos, { logCaps: { perStep: 2000, total: 8000 } });
    const s: Scenario = { name: "::add-mask:: flooding is budgeted and the mask registry is capped (review F1)", ...r, failures: [] };
    const acks = s.view.logs.filter((l) => l.text === "::add-mask::***");
    check(s, s.result === "success", `result success (got ${s.result}: ${s.view.reason ?? ""})`);
    check(s, s.events.at(-1)?.type === "execution-end", `the final result is still recorded (last event ${s.events.at(-1)?.type})`);
    check(s, acks.length * "::add-mask::***".length <= 2000 + 80, `add-mask acknowledgements are bounded by the log budget (${acks.length} lines)`);
    check(s, s.view.annotations.some((a) => a.source === "runner" && /Mask registration limit/.test(a.message)), `the mask-registration cap is reported once (got ${JSON.stringify(s.view.annotations.filter((a) => a.source === "runner").map((a) => a.message))})`);
    check(s, s.view.logs.some((l) => l.text === "AFTER_MASK_MARKER"), "a step after the flood still has its output");
    scenarios.push(s);
  }
  {
    // Security review F2/M6: a step writes a huge $GITHUB_OUTPUT. The runner reads it under a cap (never whole), bounds
    // the entry, warns, and the authenticated step/job events stay small — the result still comes through.
    const repos = demoRepos(repoRoot);
    repos[DEMO_REPO]!.files[".github/workflows/release.yml"] = F2_WORKFLOW;
    const r = await execute(repoRoot, repos, {});
    const s: Scenario = { name: "a huge GITHUB_OUTPUT is bounded, not forwarded whole (review F2)", ...r, failures: [] };
    const step = s.view.jobs[0]?.steps.find((x) => x.name === "bigoutput");
    check(s, s.result === "success", `result success (got ${s.result}: ${s.view.reason ?? ""})`);
    check(s, (step?.outputs.big?.length ?? 0) === COMMAND_FILE_LIMITS.maxEntryBytes, `the output entry is capped (got ${step?.outputs.big?.length} chars)`);
    check(s, s.view.annotations.some((a) => a.source === "runner" && /GITHUB_OUTPUT.*bytes/.test(a.message)), `a runner notice records the cap (got ${JSON.stringify(s.view.annotations.filter((a) => a.source === "runner").map((a) => a.message))})`);
    check(s, JSON.stringify(s.events).length < 256 * 1024, `the authenticated event stream stays bounded (${JSON.stringify(s.events).length} bytes)`);
    scenarios.push(s);
  }
  {
    // Security review F3/M6: a secret is positioned to straddle a truncation boundary. Because masking happens before
    // truncation, no unmasked prefix of the secret can be forwarded — once at the per-step limit, once at the
    // per-execution limit. The secret is a harmless, distinctive test value.
    const prefixLeak = (s: Scenario) => {
      const blob = JSON.stringify(s.events);
      check(s, s.result === "success", `result success (got ${s.result}: ${s.view.reason ?? ""})`);
      check(s, blob.includes("xxxxxxxx"), "the padding was forwarded, so truncation happened at the secret");
      let leaked: string | undefined;
      for (let n = 6; n <= STRADDLE_SECRET.length; n++) if (blob.includes(STRADDLE_SECRET.slice(0, n))) leaked = STRADDLE_SECRET.slice(0, n);
      check(s, leaked === undefined, `no unmasked prefix of the secret appears (found ${JSON.stringify(leaked)})`);
    };
    for (const [where, caps] of [
      ["per-step", { perStep: 2000, total: 1_000_000 }],
      ["per-execution", { perStep: 1_000_000, total: 2000 }],
    ] as const) {
      const repos = demoRepos(repoRoot);
      repos[DEMO_REPO]!.files[".github/workflows/release.yml"] = F3_WORKFLOW;
      const r = await execute(repoRoot, repos, { secret: STRADDLE_SECRET, logCaps: caps });
      const s: Scenario = { name: `a secret straddling the ${where} log limit is masked, not leaked as a prefix (review F3)`, ...r, failures: [] };
      prefixLeak(s);
      scenarios.push(s);
    }
  }
  return scenarios;
}

// Security review F1: a flood of ::add-mask:: commands, then a marker step. The runner must budget the acknowledgement
// lines, cap the mask registry (warning once), and still record the marker and the execution result.
const F1_WORKFLOW = `on:
  workflow_dispatch: {}
jobs:
  masks:
    runs-on: ubuntu-latest
    steps:
      - name: flood-masks
        run: |
          for i in $(seq 1 5000); do echo "::add-mask::mask-value-number-$i"; done
      - name: after
        run: echo AFTER_MASK_MARKER
`;

// Security review F2: a step writes a multi-megabyte value to $GITHUB_OUTPUT. The runner must read it under a cap,
// bound the entry, and keep the authenticated events small. The value is harmless filler.
const F2_WORKFLOW = `on:
  workflow_dispatch: {}
jobs:
  out:
    runs-on: ubuntu-latest
    steps:
      - id: bigoutput
        name: bigoutput
        run: |
          {
            echo "big<<EOF"
            head -c 3000000 </dev/zero | tr '\\0' y
            echo ""
            echo "EOF"
          } >> "$GITHUB_OUTPUT"
`;

// Security review F3: the step prints 1990 bytes of padding then the secret on one line, so the secret crosses a
// 2000-byte truncation boundary. Masking before truncation must leave no unmasked prefix of the secret.
const STRADDLE_SECRET = "Zx9Qvk2mPLsupersecrettoken0123456789wxyz";
const F3_WORKFLOW = `on:
  workflow_dispatch: {}
jobs:
  straddle:
    runs-on: ubuntu-latest
    steps:
      - name: straddle
        env:
          KEY: \${{ secrets.DEMO_SIGNING_KEY }}
        run: |
          pad=$(head -c 1990 </dev/zero | tr '\\0' x)
          printf '%s%s\\n' "$pad" "$KEY"
`;

// Security review M6: the first step prints far more than the per-step log budget; the second prints one marker line.
// The runner must cap the flood yet still record the second step's output and the execution's result.
const M6_WORKFLOW = `on:
  workflow_dispatch: {}
jobs:
  flood:
    runs-on: ubuntu-latest
    steps:
      - name: flood
        run: |
          for i in $(seq 1 500); do printf 'FLOOD-%04d-wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww\\n' "$i"; done
      - name: after
        run: echo AFTER_MARKER
`;

// Security review M2: the step echoes its secret raw and Base64-encoded, to stdout, stderr, a step output and an
// annotation. BEGIN/END frame the non-secret output that must stay readable. The secret is a harmless test value.
const M2_WORKFLOW = `on:
  workflow_dispatch: {}
jobs:
  leak:
    runs-on: ubuntu-latest
    steps:
      - id: enc
        name: encode
        env:
          KEY: \${{ secrets.DEMO_SIGNING_KEY }}
        run: |
          echo BEGIN
          echo "raw: $KEY"
          printf 'std: %s\\n' "$(printf '%s' "$KEY" | base64 -w0)"
          printf 'url: %s\\n' "$(printf '%s' "$KEY" | base64 -w0 | tr '+/' '-_' | tr -d '=')"
          printf 'err: %s\\n' "$(printf '%s' "$KEY" | base64 -w0)" 1>&2
          {
            echo "leaked=$KEY"
            echo "stdb64=$(printf '%s' "$KEY" | base64 -w0)"
          } >> "$GITHUB_OUTPUT"
          echo "::warning::annotated $KEY"
          echo END
`;

// Security review M1: an inert value made of the shell metacharacters an attacker would use. "M1_EXEC" is printed
// only if the value is ever evaluated as a command; as data the whole string is printed inside a labelled line.
const M1_VALUE = `"; echo M1_EXEC; echo DONE "`;
const M1_INPUT = `"; echo M1_INPUT_EXEC; echo DONE "`;
const M1_WORKFLOW = `on:
  workflow_dispatch:
    inputs:
      version:
        type: string
        required: true
jobs:
  m1:
    runs-on: ubuntu-latest
    steps:
      - id: tool
        name: tool
        run: |
          printf '%s\\n' 'v=${M1_VALUE}' >> "$GITHUB_OUTPUT"
          echo '::set-output name=forged::M1_FORGED'
      - name: double quoted
        run: |
          echo "dq: \${{ steps.tool.outputs.v }}"
      - name: single quoted
        run: |
          echo 'sq: \${{ steps.tool.outputs.v }}'
      - name: unquoted
        run: |
          echo uq: \${{ steps.tool.outputs.v }}
      - name: dispatch input
        run: |
          echo "inp: \${{ inputs.version }}"
      - name: python via env
        shell: python
        env:
          V: \${{ steps.tool.outputs.v }}
        run: |
          import os
          print("py: " + os.environ["V"])
`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const scenarios = await runChecks(root);
  let failed = 0;
  for (const s of scenarios) {
    console.log(`${s.failures.length ? "FAIL" : "PASS"} ${s.name} (result ${s.result})`);
    for (const f of s.failures) console.log(`     - ${f}`);
    failed += s.failures.length;
  }
  const first = scenarios[0]!;
  console.log("\nDemo run, jobs and steps in execution order:");
  for (const j of first.view.jobs) {
    console.log(`  ${j.job} [${j.status}]${Object.keys(j.outputs).length ? ` outputs=${JSON.stringify(j.outputs)}` : ""}`);
    for (const st of j.steps) console.log(`    ${st.step}. ${st.name} [${st.status}] exit=${st.exitCode ?? "-"}`);
  }
  process.exitCode = failed ? 1 : 0;
}
