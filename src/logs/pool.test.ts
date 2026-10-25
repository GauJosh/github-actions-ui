// The log pool: a few loads at a time, a cap on the number of logs, and disposal that terminates every worker.
import { describe, expect, it } from "vitest";
import type { LogLoader, LogSnapshot } from "./download/loader";
import { LogPool } from "./pool";

/** A loader stand-in whose status the test sets. */
function fakeLoader() {
  let snap = { status: "sizing" } as LogSnapshot;
  const listeners = new Set<(s: LogSnapshot) => void>();
  const loader = {
    started: false,
    disposed: false,
    get snapshot() {
      return snap;
    },
    subscribe(l: (s: LogSnapshot) => void) {
      listeners.add(l);
      l(snap);
      return () => listeners.delete(l);
    },
    start() {
      loader.started = true;
      return Promise.resolve();
    },
    dispose() {
      loader.disposed = true;
    },
    set(status: LogSnapshot["status"]) {
      snap = { ...snap, status };
      for (const l of [...listeners]) l(snap);
    },
  };
  return loader;
}
const ref = (jobId: number) => ({ owner: "o", repo: "r", runId: 1, jobId });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("LogPool", () => {
  it("starts at most `concurrency` loads, starts the next when one settles, and caps the number of logs", async () => {
    const made: ReturnType<typeof fakeLoader>[] = [];
    const pool = new LogPool(() => {
      const l = fakeLoader();
      made.push(l);
      return l as unknown as LogLoader;
    }, 3, 2);
    let changes = 0;
    pool.subscribe(() => changes++);
    pool.open(ref(1));
    pool.open(ref(2));
    pool.open(ref(3));
    expect(pool.open(ref(4))).toBeUndefined(); // over the cap: reported as not searched by the caller
    expect(pool.open(ref(1))).toBe(made[0]); // the same job is not loaded twice
    expect(made.map((l) => l.started)).toEqual([true, true, false]);
    made[0]!.set("complete");
    await tick();
    expect(made[2]!.started).toBe(true);
    expect(changes).toBe(3);
  });

  it("disposes every loader, and can be used again afterwards", () => {
    const made: ReturnType<typeof fakeLoader>[] = [];
    const pool = new LogPool(() => {
      const l = fakeLoader();
      made.push(l);
      return l as unknown as LogLoader;
    }, 5, 1);
    pool.open(ref(1));
    pool.open(ref(2));
    pool.dispose();
    expect(made.every((l) => l.disposed)).toBe(true);
    expect(pool.size).toBe(0);
    pool.open(ref(3));
    expect(made[2]!.started).toBe(true);
  });
});
