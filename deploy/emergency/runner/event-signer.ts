// The runner's event writer, in the format src/emergency/event-stream.ts verifies (security review H2): a key pair
// generated here, in the runner's protected memory, for this execution only. The public key is the first line
// written; every event is signed with the private key and chained to the one before. The private key is never written
// anywhere, so nothing outside this process (the Job, the executor, an API reader, a workflow step) can sign an event.
// Synchronous, so events are written in order.
import { generateKeyPairSync, sign } from "node:crypto";
import { EVENT_PREFIX, KEY_PREFIX } from "../../../src/emergency/events.ts";

export function createEventWriter(execution: string, write: (line: string) => void): (e: object) => void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // The raw 32-byte key is the end of its DER SubjectPublicKeyInfo encoding.
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  let prev = JSON.stringify({ v: 2, alg: "Ed25519", publicKey: raw, execution });
  write(`${KEY_PREFIX}${prev}\n`);
  let seq = 0;
  return (e: object) => {
    const json = JSON.stringify({ ...e, seq: seq++ });
    prev = sign(null, Buffer.from(prev + json), privateKey).toString("hex");
    write(`${EVENT_PREFIX}${prev} ${json}\n`);
  };
}
