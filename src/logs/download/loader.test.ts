import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { LARGE_LOG_SOFT_LIMIT_BYTES } from "../../config";
import { LogLoader, type LoaderOptions, type LogSnapshot } from "./loader";
import { API_HOST, inProcessWorker, sampleLog, scriptedLogServer, type Call, type Directive } from "./test-support";

const TAIL = 64 * 1024;
const LOG = sampleLog(1_000_000);
const decoder = new TextDecoder();

function setup(script?: (call: Call) => Directive | undefined, options: Partial<LoaderOptions> & { data?: Uint8Array; delayMs?: number } = {}) {
  const data = options.data ?? LOG;
  const server = scriptedLogServer(data, script);
  const loader = new LogLoader({
    request: server.request,
    apiHost: API_HOST,
    createWorker: () => inProcessWorker({ delayMs: options.delayMs }),
    sleep: async () => {},
    ...options,
    limits: { tailBytes: TAIL, ...options.limits },
  });
  return { loader, server, data };
}

async function fullText(loader: LogLoader): Promise<string> {
  const lines = await loader.rows("full", 0, loader.snapshot.lines);
  return lines.join("\n") + "\n";
}

const until = (loader: LogLoader, status: LogSnapshot["status"]) =>
  new Promise<void>((resolve) => {
    const off = loader.subscribe((s) => {
      if (s.status === status) {
        queueMicrotask(() => off());
        resolve();
      }
    });
  });

const bodyGets = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.range && c.range[1] !== LOG.length - 1);

describe("LogLoader: normal path", () => {
  it("loads HEAD, then the tail, then the body before the tail, and appends the tail once", async () => {
    const { loader, server } = setup();
    await loader.start();
    const s = loader.snapshot;
    expect(s.status).toBe("complete");
    expect(s.bytesLoaded).toBe(LOG.length);
    expect(s.crc32).toBe(zlibCrc32(LOG));
    expect(await fullText(loader)).toBe(decoder.decode(LOG));
    expect(server.calls.map((c) => [c.method, c.range])).toEqual([
      ["HEAD", undefined],
      ["GET", [LOG.length - TAIL, LOG.length - 1]],
      ["GET", [0, LOG.length - TAIL - 1]],
    ]);
    expect(s.tail?.lines.length).toBeGreaterThan(0);
    expect(loader.events.map((e) => e.event)).toEqual(["head", "tail-ready", "body-request", "complete"]);
  });

  it("loads a log smaller than the tail with a single request", async () => {
    const small = sampleLog(10_000);
    const { loader, server } = setup(undefined, { data: small });
    await loader.start();
    expect(loader.snapshot.status).toBe("complete");
    expect(await fullText(loader)).toBe(decoder.decode(small));
    expect(server.calls.map((c) => c.range)).toEqual([undefined, [0, small.length - 1]]);
  });

  it("finds lines with search across the loaded document", async () => {
    const { loader } = setup();
    await loader.start();
    const result = await loader.search("checksum mismatch");
    const expected = decoder
      .decode(LOG)
      .split("\n")
      .flatMap((l, i) => (l.includes("checksum mismatch") ? [i] : []));
    expect(result?.lines).toEqual(expected);
  });

  it("records hosts but never request URLs or query strings in diagnostics", async () => {
    const { loader } = setup();
    await loader.start();
    const text = JSON.stringify(loader.events);
    expect(text).toContain("productionresultssa0.blob.core.windows.net");
    expect(text).not.toMatch(/https?:|sig=|\?/);
  });
});

describe("LogLoader: interruptions and retries (mock log host)", () => {
  it("resumes an interrupted body from the exact byte received", async () => {
    let dropped = false;
    const { loader, server } = setup((c) => {
      if (c.method === "GET" && c.range?.[0] === 0 && !dropped) {
        dropped = true;
        return { dropAfter: 300_000 };
      }
    });
    await loader.start();
    expect(loader.snapshot.status).toBe("complete");
    expect(await fullText(loader)).toBe(decoder.decode(LOG));
    const resumed = bodyGets(server.calls)[1]!;
    expect(resumed.range![0]).toBe(300_000);
    expect(loader.events.some((e) => e.event === "resumed" && e.offset === 300_000)).toBe(true);
  });

  it("marks the log incomplete after repeated failures and keeps the bytes received", async () => {
    const { loader } = setup((c) => (c.method === "GET" && c.range && c.range[1] !== LOG.length - 1 ? { dropAfter: 50_000 } : undefined));
    await loader.start();
    const s = loader.snapshot;
    expect(s.status).toBe("incomplete");
    expect(s.bytesLoaded).toBe(4 * 50_000);
    expect(s.incompleteCause).toBe("network");
    expect(s.lines).toBeGreaterThan(0);
  });

  it("retries a 403 from the log host (signed-url-rejected) with a new request", async () => {
    let rejected = 0;
    const { loader } = setup((c) => (c.method === "GET" && c.range?.[0] === 0 && rejected++ === 0 ? { status: 403, body: "<Code>AuthenticationFailed</Code>" } : undefined));
    await loader.start();
    expect(loader.snapshot.status).toBe("complete");
    expect(loader.events.map((e) => e.event)).toContain("signed-url-rejected");
    expect(await fullText(loader)).toBe(decoder.decode(LOG));
  });

  it("treats a 403 from the API host as a permission failure, not a retry", async () => {
    const { loader } = setup((c) => (c.method === "HEAD" ? { status: 403, host: API_HOST, body: '{"message":"Must have admin rights to Repository."}' } : undefined));
    await loader.start();
    expect(loader.snapshot).toMatchObject({ status: "failed", failure: { kind: "permission", detail: "Must have admin rights to Repository." } });
  });

  it("maps 410 to expired, 404 to unavailable and 401 to an auth failure", async () => {
    for (const [status, expected] of [
      [410, "expired"],
      [404, "unavailable"],
      [401, "failed"],
    ] as const) {
      const { loader } = setup((c) => (c.method === "HEAD" ? { status, host: API_HOST } : undefined));
      await loader.start();
      expect(loader.snapshot.status).toBe(expected);
    }
  });

  it("pauses on cancel, keeps the bytes received and resumes exactly", async () => {
    const { loader, server } = setup(undefined, { delayMs: 5, limits: { tailBytes: TAIL, high: 32 * 1024, low: 16 * 1024 } });
    const done = loader.start();
    await new Promise<void>((resolve) => {
      const off = loader.subscribe((s) => {
        if (s.status === "loading" && s.bytesLoaded > 0) {
          queueMicrotask(() => off());
          loader.cancel();
          resolve();
        }
      });
    });
    await until(loader, "cancelled");
    const pausedAt = loader.snapshot.bytesLoaded;
    expect(pausedAt).toBeGreaterThan(0);
    expect(pausedAt).toBeLessThan(LOG.length - TAIL);
    loader.resume();
    await done;
    expect(loader.snapshot.status).toBe("complete");
    expect(await fullText(loader)).toBe(decoder.decode(LOG));
    expect(bodyGets(server.calls).at(-1)!.range![0]).toBe(pausedAt);
  });
});

describe("LogLoader: range refusal fallback (mock only; never observed from GitHub)", () => {
  it("falls back to one full stream when the tail range is ignored", async () => {
    const { loader, server } = setup((c) => (c.method === "GET" ? { ignoreRange: true } : undefined));
    await loader.start();
    expect(loader.snapshot.status).toBe("complete");
    expect(await fullText(loader)).toBe(decoder.decode(LOG));
    expect(loader.events.map((e) => e.event)).toContain("range-unsupported");
    expect(server.calls.at(-1)!.range).toBeUndefined();
  });

  it("discards partial data and restarts from byte 0 when a body range is ignored", async () => {
    let n = 0;
    const { loader } = setup((c) => {
      if (c.method !== "GET" || c.range?.[1] === LOG.length - 1) return undefined;
      return n++ === 0 ? { dropAfter: 100_000 } : { ignoreRange: true };
    });
    await loader.start();
    expect(loader.snapshot.status).toBe("complete");
    expect(loader.snapshot.crc32).toBe(zlibCrc32(LOG));
  });
});

describe("LogLoader: completeness checks (not content verification)", () => {
  it("rejects a response longer than the requested range", async () => {
    const { loader } = setup((c) => (c.method === "GET" && c.range?.[0] === 0 ? { extraBytes: 10 } : undefined));
    await loader.start();
    expect(loader.snapshot).toMatchObject({ status: "incomplete", incompleteCause: "unexpected-length" });
  });

  it("is incomplete when the server delivers fewer bytes than the size it reported", async () => {
    const { loader } = setup((c) => (c.method === "HEAD" ? { headLength: LOG.length + 5_000 } : undefined));
    await loader.start();
    expect(loader.snapshot).toMatchObject({ status: "incomplete", incompleteCause: "short-body" });
  });
});

describe("LogLoader: backpressure", () => {
  it("keeps un-acknowledged bytes at or below the high-water mark plus one chunk, with zero copies", async () => {
    const high = 64 * 1024;
    const { loader } = setup(undefined, { delayMs: 2, limits: { tailBytes: TAIL, high, low: 32 * 1024 } });
    await loader.start();
    expect(loader.snapshot.status).toBe("complete");
    expect(loader.transferStats.maxInflight).toBeLessThanOrEqual(high + 16 * 1024);
    expect(loader.transferStats.copies).toBe(0);
  });
});

describe("LogLoader: A8 large-log soft limit", () => {
  it("uses the configured 44,000,000-byte default", () => {
    expect(LARGE_LOG_SOFT_LIMIT_BYTES).toBe(44_000_000);
  });

  it("stops at the tail above the limit, and loads the full log only on request", async () => {
    const { loader, server } = setup(undefined, { limits: { tailBytes: TAIL, largeLogSoftLimit: 500_000 } });
    await loader.start();
    expect(loader.snapshot).toMatchObject({ status: "tail-only", fullLoad: "opt-in", lines: 0 });
    expect(loader.snapshot.tail!.lines.at(-1)).toBe(decoder.decode(LOG).trimEnd().split("\n").at(-1));
    expect(server.calls).toHaveLength(2);
    expect(await loader.search("line")).toEqual({ lines: [], capped: false });

    await loader.loadFull();
    expect(loader.snapshot.status).toBe("complete");
    expect(await fullText(loader)).toBe(decoder.decode(LOG));
  });

  it("changing only the limit changes the behaviour", async () => {
    const { loader } = setup(undefined, { limits: { tailBytes: TAIL, largeLogSoftLimit: LOG.length } });
    await loader.start();
    expect(loader.snapshot.status).toBe("complete");
  });
});

describe("LogLoader: A9 worker failure recovery", () => {
  it("re-downloads from byte 0 after a worker failure and ends complete", async () => {
    const { loader, server } = setup(undefined, { faults: { workerFailures: 1, atFraction: 0.5 } });
    await loader.start();
    const s = loader.snapshot;
    expect(s).toMatchObject({ status: "complete", restarts: 1 });
    expect(s.crc32).toBe(zlibCrc32(LOG));
    expect(loader.events.map((e) => e.event)).toEqual(expect.arrayContaining(["worker-failed", "reloading"]));
    expect(server.calls.filter((c) => c.method === "HEAD")).toHaveLength(1);
    expect(bodyGets(server.calls).at(-1)!.range![0]).toBe(0);
  });

  it("stops in processing-failed after the restart limit, and Retry recovers", async () => {
    const { loader } = setup(undefined, { faults: { workerFailures: 3, atFraction: 0.5 }, limits: { tailBytes: TAIL, maxWorkerRestarts: 2 } });
    await loader.start();
    expect(loader.snapshot).toMatchObject({ status: "processing-failed", restarts: 2 });
    await loader.retry();
    expect(loader.snapshot).toMatchObject({ status: "complete", restarts: 0, crc32: zlibCrc32(LOG) });
  });
});
