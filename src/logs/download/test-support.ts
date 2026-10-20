// Test doubles for the log loader: an in-process worker running the real handler, and a scripted
// API + log host that serves byte ranges and can inject the failures E8/E9 exercised.
import type { TransportResponse } from "../../github/transport";
import { createLogWorkerHandler } from "../worker/handler";
import type { FromWorker, ToWorker } from "../worker/protocol";
import type { WorkerPort } from "./worker-session";

export const API_HOST = "api.github.com";
export const BLOB_HOST = "productionresultssa0.blob.core.windows.net";

/** Runs the real worker handler in-process. `delayMs` slows every `bytes` message (a slow worker). */
export function inProcessWorker(options: { delayMs?: number } = {}): WorkerPort {
  let terminated = false;
  const queue: ToWorker[] = [];
  let busy = false;
  const port: WorkerPort = {
    onmessage: null,
    onfailure: null,
    postMessage(message, transfer) {
      if (terminated) return;
      // Emulate transfer semantics: the sender's buffers are detached, as with a real worker.
      const owned = transfer?.length ? (structuredClone(message, { transfer }) as ToWorker) : message;
      queue.push(owned);
      void drain();
    },
    terminate() {
      terminated = true;
    },
  };
  const handle = createLogWorkerHandler(
    (message: FromWorker) => setTimeout(() => !terminated && port.onmessage?.(message)),
    (error) => setTimeout(() => !terminated && port.onfailure?.(error.message)),
  );
  async function drain() {
    if (busy) return;
    busy = true;
    while (queue.length && !terminated) {
      const message = queue.shift()!;
      if (message.type === "bytes" && options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (!terminated) handle(message);
    }
    busy = false;
  }
  return port;
}

export type Call = { index: number; method: "GET" | "HEAD"; range?: [number, number] };
export type Directive =
  | { status: number; host?: string; body?: string }
  | { dropAfter: number }
  | { ignoreRange: true }
  | { extraBytes: number }
  | { headLength: number };

/** A fake job-log endpoint. Unscripted requests behave like GitHub: HEAD gives the size, ranges give 206. */
export function scriptedLogServer(data: Uint8Array, script: (call: Call) => Directive | undefined = () => undefined, chunk = 16 * 1024) {
  const calls: Call[] = [];
  const request = async (method: "GET" | "HEAD", range?: [number, number], signal?: AbortSignal): Promise<TransportResponse> => {
    const call: Call = { index: calls.length, method, range };
    calls.push(call);
    const d = script(call);
    if (d && "status" in d) {
      return { response: new Response(d.body ?? "{}", { status: d.status }), finalHost: d.host ?? BLOB_HOST };
    }
    if (method === "HEAD") {
      const length = d && "headLength" in d ? d.headLength : data.byteLength;
      return { response: new Response(null, { status: 200, headers: { "Content-Length": String(length) } }), finalHost: BLOB_HOST };
    }
    const useRange = range && !(d && "ignoreRange" in d);
    let slice = useRange ? data.subarray(range[0], range[1] + 1) : data;
    if (d && "extraBytes" in d) slice = new Uint8Array([...slice, ...new Uint8Array(d.extraBytes).fill(120)]);
    const dropAfter = d && "dropAfter" in d ? d.dropAfter : Infinity;
    let pos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) return controller.error(new DOMException("aborted", "AbortError"));
        if (pos >= Math.min(slice.length, dropAfter)) {
          return pos >= slice.length ? controller.close() : controller.error(new TypeError("network error"));
        }
        const end = Math.min(pos + chunk, slice.length, dropAfter);
        controller.enqueue(slice.slice(pos, end));
        pos = end;
      },
    });
    // A locked stream rejects cancel(); the pull above reports the abort to the reader instead.
    signal?.addEventListener("abort", () => body.cancel().catch(() => {}));
    return { response: new Response(body, { status: useRange ? 206 : 200 }), finalHost: BLOB_HOST };
  };
  return { request, calls };
}

/** A deterministic multi-line log of roughly `bytes` bytes, with a few non-ASCII characters. */
export function sampleLog(bytes: number): Uint8Array {
  const lines: string[] = [];
  let size = 0;
  for (let i = 1; size < bytes; i++) {
    const line = `2026-10-20T00:00:00.0000000Z line ${i} ${i % 97 === 0 ? "checksum mismatch ✓" : "ok"} ${"x".repeat(i % 50)}`;
    lines.push(line);
    size += new TextEncoder().encode(line).length + 1;
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}
