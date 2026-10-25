// A bounded set of job logs loaded for one purpose (pipeline-wide search, or a log comparison), each in its own
// worker. Loading is queued (a few at a time), the number of logs is capped, and everything is disposed with the
// pool, so logs of one run attempt never outlive it. Each log keeps the loader's policies (tail first, the A8
// large-log limit, retries, worker isolation); nothing is copied out of the workers except query results.
// Components subscribe to it (`subscribe`/`version`) to re-render when logs are opened or the pool is cleared.
import type { JobRef } from "../domain/types";
import type { LogLoader, LogSnapshot, LogStatus } from "./download/loader";

/** States in which a log will not change without a user action. */
export const SETTLED: LogStatus[] = ["complete", "tail-only", "incomplete", "cancelled", "expired", "unavailable", "failed", "processing-failed"];

export class LogPool {
  private loaders = new Map<number, LogLoader>();
  private waiting: (() => void)[] = [];
  private active = 0;
  /** Bumped by dispose(): queue callbacks of an earlier generation are ignored. */
  private generation = 0;
  private listeners = new Set<() => void>();
  private changes = 0;

  constructor(
    private readonly create: (ref: JobRef) => LogLoader,
    readonly max = 30,
    private readonly concurrency = 2,
  ) {}

  /** Changes on every open and dispose (for useSyncExternalStore). */
  readonly version = (): number => this.changes;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed(): void {
    this.changes++;
    for (const l of this.listeners) l();
  }

  get size(): number {
    return this.loaders.size;
  }

  get(jobId: number): LogLoader | undefined {
    return this.loaders.get(jobId);
  }

  /** The job's loader, queued to start; undefined when the pool is full (the caller says the log was not searched). */
  open(ref: JobRef): LogLoader | undefined {
    const existing = this.loaders.get(ref.jobId);
    if (existing) return existing;
    if (this.loaders.size >= this.max) return undefined;
    const loader = this.create(ref);
    this.loaders.set(ref.jobId, loader);
    const generation = this.generation;
    const run = () => {
      if (generation !== this.generation) return;
      this.active++;
      void loader.start();
      void settled(loader).then(() => {
        if (generation !== this.generation) return;
        this.active--;
        this.waiting.shift()?.();
      });
    };
    if (this.active < this.concurrency) run();
    else this.waiting.push(run);
    this.changed();
    return loader;
  }

  /** Terminates every worker and empties the pool (it can be used again: React may re-run effects). */
  dispose(): void {
    this.generation++;
    this.waiting = [];
    this.active = 0;
    for (const l of this.loaders.values()) l.dispose();
    this.loaders.clear();
    this.changed();
  }
}

/** Resolves with the loader's snapshot once it has settled (see SETTLED). */
export function settled(loader: LogLoader): Promise<LogSnapshot> {
  return new Promise((resolve) => {
    let done = false;
    const off = loader.subscribe((s) => {
      if (done || !SETTLED.includes(s.status)) return;
      done = true;
      resolve(s);
      // subscribe() calls the listener synchronously once, before `off` is assigned: unsubscribe afterwards.
      queueMicrotask(() => off());
    });
  });
}
