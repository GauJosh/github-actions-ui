// Entry point of the emergency runner container (deploy/emergency/Dockerfile, target "runner"). Configuration comes
// from the Job spec the executor writes (deploy/emergency/executor/job-spec.ts); events go to stdout, one per line.
// Exit code: 0 when the workflow succeeded, 1 when it failed, 2 when the runner itself could not start.
//
// Security review H3: workflow processes run as the same user as the runner, so the runner must be out of their
// reach. The Job starts it from an execute-only copy of node (mode 0111, owned by root), which makes the kernel mark
// the process non-dumpable: its /proc/<pid> entries belong to root, so workflow code can't reopen its stdout (the
// event channel), read its memory (the event signing key) or environment, or attach to it. It runs as PID 1, which ignores
// signals it has no handler for, and with --disable-sigusr1 so a signal can't start the inspector. The runner checks
// this at startup and refuses to run without it.
//
// Every event line is signed with a key pair the runner generates at startup (security review H2): the public key is
// the first line of the log, the private key never leaves this process (event-signer.ts; event-stream.ts has the
// format and the executor's check). Workflow processes get a minimal environment of their own (engine.ts).
import { statSync } from "node:fs";
import { runSnapshot } from "./engine.ts";
import { createEventWriter } from "./event-signer.ts";

/** The execution's id, which the key line names; the rest of the configuration is read in config(). */
function executionId(): string {
  try {
    return String((JSON.parse(process.env.GHA_EMERGENCY_EXECUTION ?? "") as { id?: unknown }).id ?? "unknown");
  } catch {
    return "unknown";
  }
}
/** The only writer of event lines; stdout is a pipe, so each write is synchronous and in order. */
const emit = createEventWriter(executionId(), (line) => process.stdout.write(line));

/** Whether this process is non-dumpable: its /proc entries then belong to root, not to the runner's user. */
function protectedProcess(): { ok: boolean; detail: string } {
  if (process.platform !== "linux") return { ok: false, detail: `platform ${process.platform}` };
  try {
    const owner = statSync("/proc/self/fd").uid;
    return owner === 0 && process.getuid?.() !== 0
      ? { ok: true, detail: "non-dumpable: /proc/self is owned by root" }
      : { ok: false, detail: `/proc/self is owned by uid ${owner} (the runner runs as uid ${process.getuid?.()})` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

function config() {
  const raw = process.env.GHA_EMERGENCY_EXECUTION;
  if (!raw) throw new Error("GHA_EMERGENCY_EXECUTION is not set");
  const execution = JSON.parse(raw) as { id: string; workflow: string; digest: string; inputs: Record<string, string>; variables: Record<string, string> };
  return {
    snapshotDir: process.env.GHA_EMERGENCY_SNAPSHOT_DIR ?? "/snapshot",
    workDir: process.env.GHA_EMERGENCY_WORK_DIR ?? "/work",
    secretsDir: process.env.GHA_EMERGENCY_SECRETS_DIR ?? "/secrets",
    execution: { id: execution.id, workflow: execution.workflow, digest: execution.digest, inputs: execution.inputs ?? {}, variables: execution.variables ?? {} },
    maxMinutes: Number(process.env.GHA_EMERGENCY_MAX_MINUTES ?? 60),
    networkProbe: (process.env.GHA_EMERGENCY_NETWORK_PROBE ?? "github.com,api.github.com,codeload.github.com").split(",").filter(Boolean),
    emit,
  };
}

const end = (reason: string, code: number) => {
  emit({ type: "execution-end", at: new Date().toISOString(), result: "failure", durationMs: 0, outputs: {}, reason });
  process.exitCode = code;
};

const guard = protectedProcess();
if (!guard.ok) {
  end(`Refusing to run: the runner's events can't be protected from workflow code (${guard.detail})`, 2);
} else {
  try {
    const result = await runSnapshot(config());
    process.exitCode = result === "success" ? 0 : 1;
  } catch (error) {
    end(`Runner could not start: ${(error as Error).message}`, 2);
  }
}
