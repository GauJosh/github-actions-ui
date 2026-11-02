// Integrity of the runner's event stream (security review H3). Pure: Web Crypto only.
//
// Only the runner writes to its stdout: it runs non-dumpable (deploy/emergency/runner/main.ts), so workflow processes,
// which run as the same user, can't reopen its stdout through /proc, read its memory or attach to it; their own
// output reaches the runner only through pipes it reads and wraps as data in `log` events. On top of that every
// event line is signed, and chained to the one before it, so the executor detects any event that was forged,
// altered, removed, reordered or inserted, and a stream that was cut short (log truncation or rotation, a killed
// runner). Events after the first break are not believed. A line that isn't an event means something other than the
// runner wrote to its log, which breaks the stream too.
//
// Two formats:
// - "ed25519" (security review H2, current): the runner generates a key pair when it starts, in its protected
//   memory, and writes the public key as the first line of its log, before any workflow process exists. No secret
//   leaves the runner: nothing in the Job, the pod, the executor's records or the API can sign an event.
//     KEY_PREFIX {"v":2,"alg":"Ed25519","publicKey":<hex>,"execution":<id>}
//     EVENT_PREFIX <signature> <json>      json includes "seq": 0, 1, 2, ...
//     signature = Ed25519(private key, <previous signature> + json), the first event chaining from the key line's JSON
// - "hmac" (H3, executions recorded before H2): a per-execution key the executor generated and passed in the Job's
//   environment, where anyone able to read the Job could see it. Still verified, with the key the executor kept.
//     EVENT_PREFIX <mac> <json>, mac = HMAC-SHA256(key, <previous mac> + json), chaining from GENESIS
import { EVENT_PREFIX, KEY_PREFIX, summarize, type ExecutionView, type RunnerEvent } from "./events.ts";

export const GENESIS = "0".repeat(64);

export type StreamIntegrity = {
  ok: boolean;
  /** Events accepted (a prefix of the stream when it is broken). */
  events: number;
  /** The stream ends with execution-end. */
  complete: boolean;
  /** An execution from before event authentication (H3): readable but not verifiable. */
  legacy?: boolean;
  problem?: string;
};

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/**
 * How an execution's events are verified: the executor's own record of the execution, never something in the log.
 * - ed25519: the public key on the log's first line, which must name this execution;
 * - hmac: the key the executor generated for it (H3, executions from before H2);
 * - legacy: recorded before event authentication (H3); readable, not verifiable.
 */
export type EventVerification = { kind: "ed25519"; execution: string } | { kind: "hmac"; key: string } | { kind: "legacy" };

/** An Ed25519 signer, as the runner signs (Web Crypto twin of deploy/emergency/runner/event-signer.ts, for tests). */
export async function ed25519EventSigner(execution: string): Promise<{ keyLine: string; sign: (e: object) => Promise<string> }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const keyJson = JSON.stringify({ v: 2, alg: "Ed25519", publicKey: hex(await crypto.subtle.exportKey("raw", pair.publicKey)), execution });
  let seq = 0;
  let prev = keyJson;
  return {
    keyLine: `${KEY_PREFIX}${keyJson}`,
    sign: async (e: object) => {
      const json = JSON.stringify({ ...e, seq: seq++ });
      prev = hex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(prev + json)));
      return `${EVENT_PREFIX}${prev} ${json}`;
    },
  };
}

/** Signs event lines with an executor-generated key (the H3 format, kept to test historical executions). */
export async function eventSigner(keyHex: string): Promise<(e: object) => Promise<string>> {
  const key = await importKey(keyHex);
  let seq = 0;
  let prev = GENESIS;
  return async (e: object) => {
    const json = JSON.stringify({ ...e, seq: seq++ });
    prev = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prev + json)));
    return `${EVENT_PREFIX}${prev} ${json}`;
  };
}

async function importKey(keyHex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error("The event key must be 32 bytes, hex-encoded");
  return crypto.subtle.importKey("raw", unhex(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Reads the Ed25519 key line; undefined with a reason when it isn't this execution's. */
async function ed25519Key(line: string | undefined, execution: string): Promise<{ key?: CryptoKey; chain?: string; problem?: string }> {
  if (!line?.startsWith(KEY_PREFIX)) return { problem: "The runner's log does not begin with its public key" };
  const json = line.slice(KEY_PREFIX.length);
  let k: { v?: unknown; alg?: unknown; publicKey?: unknown; execution?: unknown };
  try {
    k = JSON.parse(json) as typeof k;
  } catch {
    return { problem: "The runner's key line is not valid JSON" };
  }
  if (k.v !== 2 || k.alg !== "Ed25519" || typeof k.publicKey !== "string" || !/^[0-9a-f]{64}$/.test(k.publicKey)) return { problem: "The runner's key line is malformed" };
  if (k.execution !== execution) return { problem: `The runner's key line names execution ${String(k.execution)}, not ${execution}` };
  return { key: await crypto.subtle.importKey("raw", unhex(k.publicKey), { name: "Ed25519" }, false, ["verify"]), chain: json };
}

/** The runner's events from its log, believed only as far as they verify (see EventVerification). */
export async function verifyEventStream(text: string, verification: EventVerification): Promise<{ events: RunnerEvent[]; integrity: StreamIntegrity }> {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (verification.kind === "legacy") {
    const events = lines.flatMap((l) => {
      if (!l.startsWith(EVENT_PREFIX)) return [];
      try {
        return [JSON.parse(l.slice(EVENT_PREFIX.length)) as RunnerEvent];
      } catch {
        return [];
      }
    });
    return { events, integrity: { ok: false, legacy: true, events: events.length, complete: events.at(-1)?.type === "execution-end", problem: "Recorded before event authentication (security review H3): not verifiable" } };
  }
  let verify: (signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) => Promise<boolean>;
  let prev: string;
  let first = 0;
  const signatureLength = verification.kind === "ed25519" ? 128 : 64;
  if (verification.kind === "ed25519") {
    const k = await ed25519Key(lines[0], verification.execution);
    if (!k.key) return { events: [], integrity: { ok: false, events: 0, complete: false, problem: k.problem } };
    verify = (signature, data) => crypto.subtle.verify({ name: "Ed25519" }, k.key!, signature, data);
    prev = k.chain!;
    first = 1;
  } else {
    const key = await importKey(verification.key);
    verify = (signature, data) => crypto.subtle.verify("HMAC", key, signature, data);
    prev = GENESIS;
  }
  const events: RunnerEvent[] = [];
  let problem: string | undefined;
  for (const [i, line] of lines.entries()) {
    if (i < first) continue;
    const m = line.startsWith(EVENT_PREFIX) ? new RegExp(`^([0-9a-f]{${signatureLength}}) (.*)$`, "s").exec(line.slice(EVENT_PREFIX.length)) : null;
    if (!m) {
      problem = `Line ${i + 1} of the runner's log is not a runner event: something other than the runner wrote to it`;
      break;
    }
    const [, mac, json] = m as unknown as [string, string, string];
    if (!(await verify(unhex(mac), new TextEncoder().encode(prev + json)))) {
      problem = `Event ${events.length} is not authentic: it was forged, altered, or events before it were removed or reordered`;
      break;
    }
    let e: RunnerEvent & { seq?: unknown };
    try {
      e = JSON.parse(json) as RunnerEvent & { seq?: unknown };
    } catch {
      problem = `Event ${events.length} is not valid JSON`;
      break;
    }
    // Authentic events are well-formed; these checks guard against a runner bug, not an attacker.
    if (e.seq !== events.length) {
      problem = `Event sequence broken at ${events.length} (found ${String(e.seq)})`;
      break;
    }
    if (events.length === 0 && e.type !== "execution-start" && e.type !== "execution-end") {
      problem = "The stream does not begin with execution-start";
      break;
    }
    if (events.at(-1)?.type === "execution-end") {
      problem = "Events follow execution-end";
      break;
    }
    events.push(e);
    prev = mac;
  }
  const complete = events.at(-1)?.type === "execution-end";
  return { events, integrity: { ok: !problem, events: events.length, complete, problem } };
}

/**
 * The execution's view from the runner's log, as the executor reports it. Only authentic events are believed; a
 * finished run needs the runner's authentic final event, and that result must agree with the runner container's
 * exit code from Kubernetes (0 for success, otherwise failure). Anything else is an error, never success. Legacy
 * executions are reported as their events say, marked unverifiable.
 */
export async function judgeExecution(text: string, verification: EventVerification, exitCode: number | undefined, finished: boolean): Promise<ExecutionView> {
  const { events, integrity } = await verifyEventStream(text, verification);
  const view = summarize(events);
  view.stream = integrity;
  view.exitCode = exitCode;
  if (finished && !text && verification.kind === "ed25519") {
    view.status = "error";
    view.reason = "The runner's log is empty";
  } else if (!integrity.ok && !integrity.legacy && (text || verification.kind !== "ed25519")) {
    view.status = "error";
    view.reason = `The runner's event stream failed verification: ${integrity.problem}`;
  } else if (finished && integrity.events > 0 && !integrity.complete) {
    view.status = "error";
    view.reason = "The runner's event stream is incomplete: its final result was not recorded";
  } else if (finished && integrity.complete && exitCode !== undefined && (view.status === "success") !== (exitCode === 0)) {
    view.reason = `The runner reported ${view.status}, but its container exited with code ${exitCode}`;
    view.status = "error";
  }
  return view;
}

/**
 * Untrusted text (workflow output, names from workflow files) made safe to display: control characters (other than
 * tab), ANSI escape sequences and Unicode bidirectional/invisible formatting characters become visible escapes, so
 * workflow output can't rewrite a terminal line, hide text or reorder what a reader sees.
 */
export function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}
