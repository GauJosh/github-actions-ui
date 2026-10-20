// Main-thread side of one log worker: request/reply, zero-copy transfer, and credit-based backpressure.
import type { FromWorker, ToWorker } from "../worker/protocol";

/** Minimal worker surface, so tests can substitute an in-process worker. */
export interface WorkerPort {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((message: FromWorker) => void) | null;
  onfailure: ((reason: string) => void) | null;
  terminate(): void;
}

export function createBrowserWorkerPort(): WorkerPort {
  const worker = new Worker(new URL("../worker/log-worker.ts", import.meta.url), { type: "module", name: "log-worker" });
  const port: WorkerPort = {
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onmessage: null,
    onfailure: null,
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => port.onmessage?.(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    port.onfailure?.("worker error");
  };
  worker.onmessageerror = () => port.onfailure?.("worker message error");
  return port;
}

export class WorkerFailed extends Error {
  constructor(reason: string) {
    super(`Log worker failed: ${reason}`);
    this.name = "WorkerFailed";
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Request = DistributiveOmit<Extract<ToWorker, { id: number }>, "id">;

export class WorkerSession {
  private seq = 0;
  private pending = new Map<number, (value: unknown) => void>();
  private inflight = 0;
  private drainWaiters: (() => void)[] = [];
  private failure: WorkerFailed | null = null;
  private rejectDead!: (error: WorkerFailed) => void;
  /** Never resolves; rejects once when the worker fails. Raced against every wait. */
  private readonly dead = new Promise<never>((_, reject) => (this.rejectDead = reject));
  maxInflight = 0;
  copies = 0;

  constructor(
    private readonly port: WorkerPort,
    private readonly high: number,
    private readonly low: number,
  ) {
    port.onmessage = (message) => {
      if (message.type === "ack") {
        this.inflight -= message.n;
        if (this.inflight <= this.low) this.drainWaiters.splice(0).forEach((resolve) => resolve());
      } else {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(message.value);
      }
    };
    port.onfailure = (reason) => this.fail(reason);
    this.dead.catch(() => {});
  }

  get failed(): boolean {
    return this.failure !== null;
  }

  private fail(reason: string): void {
    if (this.failure) return;
    this.failure = new WorkerFailed(reason);
    this.rejectDead(this.failure);
    this.port.terminate();
  }

  ask<T>(request: Request, transfer?: Transferable[]): Promise<T> {
    const id = ++this.seq;
    const reply = new Promise<T>((resolve) => this.pending.set(id, resolve as (value: unknown) => void));
    if (!this.failure) this.port.postMessage({ ...request, id } as ToWorker, transfer);
    return Promise.race([reply, this.dead]);
  }

  /** Transfers a chunk without copying when it owns its whole buffer; waits while too much is un-acknowledged. */
  async send(chunk: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    let buf = chunk.buffer as ArrayBuffer;
    if (chunk.byteOffset !== 0 || chunk.byteLength !== buf.byteLength) {
      buf = chunk.slice().buffer;
      this.copies++;
    }
    this.inflight += buf.byteLength;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    this.port.postMessage({ type: "bytes", buf }, [buf]);
    if (this.inflight > this.high) {
      await Promise.race([new Promise<void>((resolve) => this.drainWaiters.push(resolve)), this.dead]);
    }
  }

  post(message: ToWorker): void {
    if (!this.failure) this.port.postMessage(message);
  }

  terminate(): void {
    this.fail("terminated");
  }
}
