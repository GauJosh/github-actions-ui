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
import { runSnapshot } from "../../deploy/emergency/runner/engine.ts";
import { createStore } from "../../deploy/emergency/executor/store.ts";
import { summarize, type ExecutionView, type RunnerEvent } from "../../src/emergency/events.ts";
import { createMemoryReader, type MemoryRepo } from "../../src/emergency/memory-reader.ts";
import { prepareSnapshot } from "../../src/emergency/prepare.ts";
import { manifestDigest, toBase64 } from "../../src/emergency/snapshot.ts";
import { DEMO_REPO, demoRepos } from "./demo-repos.ts";

export const SECRET = "demo-signing-key-7f3a91c2";

export type Scenario = { name: string; view: ExecutionView; events: RunnerEvent[]; result: string; failures: string[] };

async function execute(repoRoot: string, repos: Record<string, MemoryRepo>, opts: { secret?: string; tamper?: boolean; inputs?: Record<string, string>; extraSecrets?: Record<string, string>; forgeStripErrors?: boolean }) {
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
  return scenarios;
}

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
