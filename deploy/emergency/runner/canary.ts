// Network canary (security review C2): tries a TCP connection to each target and prints one result line per target.
// Run by the executor in a probe pod (an execution's exact labels and network settings) and in a control pod
// (deploy/emergency/executor/network-check.ts). Targets are IP addresses, so the result doesn't depend on DNS.
import { connect } from "node:net";
import { CANARY_PREFIX } from "../../../src/emergency/events.ts";

type Target = { name: string; host: string; port: number };

function attempt(t: Target): Promise<{ name: string; host: string; port: number; reachable: boolean; detail: string }> {
  return new Promise((done) => {
    const socket = connect({ host: t.host, port: t.port, timeout: 4000 });
    const finish = (reachable: boolean, detail: string) => {
      socket.destroy();
      done({ ...t, reachable, detail });
    };
    socket.once("connect", () => finish(true, "TCP connection established"));
    socket.once("timeout", () => finish(false, "timed out after 4 s"));
    socket.once("error", (e: NodeJS.ErrnoException) => finish(false, e.code ?? e.message));
  });
}

const targets = JSON.parse(process.env.GHA_EMERGENCY_CANARY_TARGETS ?? "[]") as Target[];
for (const result of await Promise.all(targets.map(attempt))) process.stdout.write(`${CANARY_PREFIX}${JSON.stringify(result)}\n`);
