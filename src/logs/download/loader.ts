// Tail-first job-log loader (R4, docs/ARCHITECTURE.md §6): HEAD → tail range → body range → append tail.
// Owns retries, resume, cancellation, the A8 large-log policy, A9 worker recovery and completeness checks.
// Diagnostics record hosts, statuses, offsets and timings only: never URLs, tokens or signatures.
import { redact } from "../../auth/redact";
import {
  BACKPRESSURE_HIGH_BYTES,
  BACKPRESSURE_LOW_BYTES,
  LARGE_LOG_SOFT_LIMIT_BYTES,
  MAX_DOWNLOAD_RETRIES,
  MAX_WORKER_RESTARTS,
  TAIL_BYTES,
} from "../../config";
import type { LogMarkers } from "../../domain/steps/step-map";
import type { ApiFailure } from "../../domain/types";
import { GitHubError, classifyFailure } from "../../github/client";
import type { ReadMethod, TransportResponse } from "../../github/transport";
import type { ViewRow, ViewSpec, ViewSummary } from "../../domain/logs/view";
import type { RowsResult, SearchResult, TailSummary, ViewRowsResult } from "../worker/protocol";
import type { StoreStats } from "../worker/store";
import { WorkerFailed, WorkerSession, type WorkerPort } from "./worker-session";

export type LogStatus =
  | "sizing"
  | "tail"
  | "loading"
  | "cancelled"
  | "tail-only"
  | "complete"
  | "incomplete"
  | "expired"
  | "unavailable"
  | "failed"
  | "processing-failed";

export type Notice =
  | { kind: "retrying"; cause: string; attempt: number; of: number; offset: number }
  | { kind: "reloading"; restart: number; of: number }
  | { kind: "range-unsupported" };

export type LogSnapshot = {
  status: LogStatus;
  bytesTotal?: number;
  bytesLoaded: number;
  /** A8: "opt-in" when the log is above the soft limit and the full log loads only on request. */
  fullLoad: "automatic" | "opt-in";
  restarts: number;
  tail?: TailSummary & { fromInterruptedLoad: boolean };
  /** Lines available in the full document so far. */
  lines: number;
  /** Diagnostic only; compared with fixture reference values in tests. Not a verification of live content. */
  crc32?: number;
  notice?: Notice;
  failure?: ApiFailure;
  incompleteCause?: string;
  errorDetail?: string;
};

export type DiagnosticEvent = { t: number; event: string; host?: string; status?: number; offset?: number; detail?: string };

export type Limits = {
  largeLogSoftLimit: number;
  maxWorkerRestarts: number;
  tailBytes: number;
  high: number;
  low: number;
  maxRetries: number;
};

export type LoaderOptions = {
  request(method: ReadMethod, range?: [number, number], signal?: AbortSignal): Promise<TransportResponse>;
  apiHost: string;
  createWorker(): WorkerPort;
  limits?: Partial<Limits>;
  sleep?: (ms: number) => Promise<void>;
  /** Fixture-mode fault injection only: fail the first `workerFailures` workers at `atFraction` of the body. */
  faults?: { workerFailures: number; atFraction: number };
};

class Superseded extends Error {}
class Retryable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const TERMINAL: LogStatus[] = ["incomplete", "expired", "unavailable", "failed", "processing-failed"];
const isNetworkError = (e: unknown) =>
  e instanceof TypeError || (e as Error | undefined)?.name === "AbortError" || (e instanceof GitHubError && e.failure.kind === "network");
const retryableFailure = (f: ApiFailure) =>
  f.kind === "signed-url-rejected" || f.kind === "network" || (f.kind === "http-error" && f.status >= 500);

export class LogLoader {
  private snap: LogSnapshot = { status: "sizing", bytesLoaded: 0, fullLoad: "automatic", restarts: 0, lines: 0 };
  private listeners = new Set<(snapshot: LogSnapshot) => void>();
  readonly events: DiagnosticEvent[] = [];
  private readonly limits: Limits;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly t0 = Date.now();
  private session: WorkerSession | null = null;
  private gen = 0;
  private abort: AbortController | null = null;
  private cancelRequested = false;
  private resumeWaiter: (() => void) | null = null;
  private total: number | undefined;
  private sized = false;
  private offset = 0;
  private tailKept = false;
  private rangeUnsupported = false;
  private optedIn = false;
  private workersCreated = 0;
  private faultInjected = false;
  private lastEmit = 0;
  private lastStats = 0;

  constructor(private readonly opts: LoaderOptions) {
    this.limits = {
      largeLogSoftLimit: LARGE_LOG_SOFT_LIMIT_BYTES,
      maxWorkerRestarts: MAX_WORKER_RESTARTS,
      tailBytes: TAIL_BYTES,
      high: BACKPRESSURE_HIGH_BYTES,
      low: BACKPRESSURE_LOW_BYTES,
      maxRetries: MAX_DOWNLOAD_RETRIES,
      ...opts.limits,
    };
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ---- public API ------------------------------------------------------------------------------

  get snapshot(): LogSnapshot {
    return this.snap;
  }

  /** Bytes still waiting for the worker at the worst point, and chunks that had to be copied. For tests and diagnostics. */
  get transferStats(): { maxInflight: number; copies: number } {
    return { maxInflight: this.session?.maxInflight ?? 0, copies: this.session?.copies ?? 0 };
  }

  subscribe(listener: (snapshot: LogSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snap);
    return () => this.listeners.delete(listener);
  }

  /** Starts (or restarts) from scratch. Safe after dispose(), which React's StrictMode does once in development. */
  start(): Promise<void> {
    this.session?.terminate();
    this.session = null;
    this.total = undefined;
    this.sized = false;
    this.offset = 0;
    this.tailKept = false;
    this.rangeUnsupported = false;
    this.optedIn = false;
    this.cancelRequested = false;
    this.snap = { status: "sizing", bytesLoaded: 0, fullLoad: "automatic", restarts: 0, lines: 0 };
    return this.drive(++this.gen, "start");
  }

  /** A8: the user chose to load a log above the soft limit. */
  loadFull(): Promise<void> {
    if (this.snap.status !== "tail-only") return Promise.resolve();
    this.optedIn = true;
    return this.drive(++this.gen, this.rangeUnsupported || !this.session ? "start" : "body");
  }

  cancel(): void {
    if (this.snap.status !== "loading") return;
    this.cancelRequested = true;
    this.abort?.abort();
  }

  resume(): void {
    const resume = this.resumeWaiter;
    this.resumeWaiter = null;
    resume?.();
  }

  /** Recover from `incomplete` (continue from the bytes received), `processing-failed` or a failed request (start over). */
  retry(): Promise<void> {
    const status = this.snap.status;
    if (status === "incomplete" && this.session && !this.session.failed && this.sized) {
      return this.drive(++this.gen, this.tailKept || this.total === undefined || this.total <= this.limits.tailBytes || this.rangeUnsupported ? "body" : "start");
    }
    if (!TERMINAL.includes(status)) return Promise.resolve();
    this.session?.terminate();
    this.session = null;
    this.offset = 0;
    this.tailKept = false;
    if (status !== "processing-failed") this.sized = false;
    this.update({ restarts: 0, bytesLoaded: 0, lines: 0, notice: undefined, failure: undefined, incompleteCause: undefined, errorDetail: undefined });
    this.event("retry-requested");
    return this.drive(++this.gen, "start");
  }

  dispose(): void {
    this.gen++;
    this.abort?.abort();
    this.session?.terminate();
    this.session = null;
  }

  async rows(doc: "tail" | "full", from: number, count: number): Promise<string[]> {
    const session = this.session;
    if (!session || session.failed) return doc === "tail" ? (this.snap.tail?.lines.slice(from, from + count) ?? []) : [];
    try {
      return (await session.ask<RowsResult>({ type: "rows", doc, from, count })).lines;
    } catch {
      return [];
    }
  }

  async search(query: string, cap = 500): Promise<SearchResult | null> {
    const session = this.session;
    if (!session || session.failed) return null;
    try {
      return await session.ask<SearchResult>({ type: "search", query, cap });
    } catch {
      return null;
    }
  }

  /** Builds the display view over the lines loaded so far. Null when no worker holds the log. */
  async view(spec: ViewSpec): Promise<ViewSummary | null> {
    const session = this.session;
    if (!session || session.failed) return null;
    try {
      return await session.ask<ViewSummary>({ type: "view", spec });
    } catch {
      return null;
    }
  }

  /** Rows of view `version`; empty once a newer view was built. */
  async viewRows(version: number, from: number, count: number): Promise<ViewRow[]> {
    const session = this.session;
    if (!session || session.failed) return [];
    try {
      return (await session.ask<ViewRowsResult>({ type: "view-rows", version, from, count })).rows;
    } catch {
      return [];
    }
  }

  /** Step markers of the complete log. Null until the full log has loaded (absolute line numbers need it). */
  async markers(): Promise<LogMarkers | null> {
    const session = this.session;
    if (this.snap.status !== "complete" || !session || session.failed) return null;
    try {
      return await session.ask<LogMarkers>({ type: "markers" });
    } catch {
      return null;
    }
  }

  // ---- state -------------------------------------------------------------------------------------

  private update(patch: Partial<LogSnapshot>, throttled = false): void {
    this.snap = { ...this.snap, ...patch };
    const now = Date.now();
    if (throttled && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    this.listeners.forEach((listener) => listener(this.snap));
  }

  private event(event: string, data: Omit<DiagnosticEvent, "t" | "event"> = {}): void {
    if (this.events.length >= 500) this.events.shift();
    this.events.push({ t: Date.now() - this.t0, event, ...data });
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Superseded();
  }

  private terminal(failure: ApiFailure, host?: string, status?: number): void {
    const next: LogStatus = failure.kind === "expired" ? "expired" : failure.kind === "not-found-or-no-permission" ? "unavailable" : "failed";
    this.update({ status: next, failure, notice: undefined });
    this.event(next, { host, status, detail: failure.kind });
  }

  private async incomplete(cause: string): Promise<void> {
    const lines = await this.availableLines();
    this.update({ status: "incomplete", incompleteCause: cause, bytesLoaded: this.offset, lines, notice: undefined });
    this.event("incomplete", { offset: this.offset, detail: cause });
  }

  private async availableLines(): Promise<number> {
    const session = this.session;
    if (!session || session.failed) return 0;
    try {
      return (await session.ask<StoreStats>({ type: "stats" })).lines;
    } catch {
      return 0;
    }
  }

  private ensureSession(): WorkerSession {
    if (!this.session || this.session.failed) {
      this.workersCreated++;
      this.faultInjected = false;
      this.session = new WorkerSession(this.opts.createWorker(), this.limits.high, this.limits.low);
    }
    return this.session;
  }

  private async request(method: ReadMethod, range?: [number, number], signal?: AbortSignal): Promise<TransportResponse> {
    return this.opts.request(method, range, signal);
  }

  // ---- driver ------------------------------------------------------------------------------------

  private async drive(gen: number, entry: "start" | "body"): Promise<void> {
    let step = entry;
    for (;;) {
      try {
        if (step === "start") {
          await this.sizeAndTail(gen);
          if (TERMINAL.includes(this.snap.status)) return;
          if (this.snap.fullLoad === "opt-in" && !this.optedIn) {
            this.update({ status: "tail-only", notice: undefined });
            this.event("tail-only", { detail: `size ${this.total} above soft limit ${this.limits.largeLogSoftLimit}` });
            return;
          }
        }
        await this.body(gen);
        return;
      } catch (error) {
        if (error instanceof Superseded || gen !== this.gen) return;
        if (error instanceof WorkerFailed) {
          this.event("worker-failed", { offset: this.offset });
          const max = this.limits.maxWorkerRestarts;
          if (this.snap.restarts >= max) {
            this.update({ status: "processing-failed", notice: undefined });
            this.event("processing-failed");
            return;
          }
          const restart = this.snap.restarts + 1;
          this.session?.terminate();
          this.session = null;
          this.offset = 0;
          this.tailKept = false;
          this.update({
            restarts: restart,
            notice: { kind: "reloading", restart, of: max },
            bytesLoaded: 0,
            lines: 0,
            tail: this.snap.tail ? { ...this.snap.tail, fromInterruptedLoad: true } : undefined,
          });
          this.event("reloading", { detail: `restart ${restart} of ${max}, from byte 0` });
          step = "start";
          continue;
        }
        this.update({ status: "failed", notice: undefined, errorDetail: redact(String((error as Error)?.message ?? error)).slice(0, 200) });
        this.event("failed", { detail: "unexpected error" });
        return;
      }
    }
  }

  private async sizeAndTail(gen: number): Promise<void> {
    if (!this.sized) {
      this.update({ status: "sizing" });
      let r: TransportResponse;
      try {
        r = await this.request("HEAD");
      } catch (error) {
        this.check(gen);
        if (!isNetworkError(error)) throw error;
        this.terminal({ kind: "network" });
        return;
      }
      this.check(gen);
      if (!r.response.ok) {
        this.terminal(await classifyFailure(r, this.opts.apiHost), r.finalHost, r.response.status);
        return;
      }
      const header = r.response.headers.get("content-length");
      const length = header === null ? NaN : Number(header);
      this.total = Number.isInteger(length) && length >= 0 ? length : undefined;
      this.sized = true;
      const fullLoad = this.total !== undefined && this.total > this.limits.largeLogSoftLimit ? "opt-in" : "automatic";
      this.update({ bytesTotal: this.total, fullLoad });
      this.event("head", { host: r.finalHost, status: r.response.status, detail: this.total === undefined ? "size unknown" : `${this.total} bytes` });
    }
    const session = this.ensureSession();
    const total = this.total;
    const tailBytes = this.limits.tailBytes;
    if (total === undefined || total <= tailBytes || this.rangeUnsupported) return;

    this.update({ status: "tail" });
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.request("GET", [total - tailBytes, total - 1]);
        this.check(gen);
        if (r.response.status === 206) {
          const buf = await r.response.arrayBuffer();
          this.check(gen);
          if (buf.byteLength !== tailBytes) throw new Retryable(buf.byteLength < tailBytes ? "short-body" : "unexpected-length");
          const summary = await session.ask<TailSummary>({ type: "tail", buf, startsMidLog: true }, [buf]);
          this.check(gen);
          this.tailKept = true;
          this.update({ tail: { ...summary, fromInterruptedLoad: false } });
          this.event("tail-ready", { host: r.finalHost, status: 206, detail: `${tailBytes} bytes, ${summary.lineCount} lines` });
          return;
        }
        if (r.response.status === 200) {
          await r.response.body?.cancel();
          this.rangeUnsupported = true;
          this.update({ notice: { kind: "range-unsupported" } });
          this.event("range-unsupported", { host: r.finalHost, status: 200 });
          return;
        }
        if (!r.response.ok) {
          const failure = await classifyFailure(r, this.opts.apiHost);
          if (!retryableFailure(failure)) {
            this.terminal(failure, r.finalHost, r.response.status);
            return;
          }
          this.event(failure.kind, { host: r.finalHost, status: r.response.status });
          throw new Retryable(failure.kind);
        }
        await r.response.body?.cancel();
        throw new Retryable(`status-${r.response.status}`);
      } catch (error) {
        this.check(gen);
        if (!(error instanceof Retryable) && !isNetworkError(error)) throw error;
        const cause = error instanceof Retryable ? error.reason : "network";
        this.event("interrupted", { offset: total - tailBytes, detail: `tail: ${cause}` });
        if (attempt > this.limits.maxRetries) {
          await this.incomplete(cause);
          return;
        }
        this.update({ notice: { kind: "retrying", cause, attempt, of: this.limits.maxRetries, offset: total - tailBytes } });
        await this.sleep(200 * attempt);
        this.check(gen);
      }
    }
  }

  private async body(gen: number): Promise<void> {
    const session = this.ensureSession();
    const total = this.total;
    let end = total === undefined ? undefined : this.tailKept ? total - this.limits.tailBytes - 1 : total - 1;
    this.update({ status: "loading", bytesLoaded: this.offset });
    let failures = 0;

    while (total !== 0 && (end === undefined || this.offset <= end)) {
      const ac = new AbortController();
      this.abort = ac;
      try {
        const useRange = !this.rangeUnsupported && end !== undefined;
        if (!useRange && this.offset > 0) {
          await session.ask({ type: "reset" });
          this.offset = 0;
          this.update({ bytesLoaded: 0, lines: 0 });
        }
        const r = await this.request("GET", useRange ? [this.offset, end!] : undefined, ac.signal);
        this.check(gen);
        if (!r.response.ok) {
          const failure = await classifyFailure(r, this.opts.apiHost);
          if (!retryableFailure(failure)) {
            this.terminal(failure, r.finalHost, r.response.status);
            return;
          }
          this.event(failure.kind, { host: r.finalHost, status: r.response.status, offset: this.offset });
          throw new Retryable(failure.kind);
        }
        if (useRange && r.response.status === 200) {
          // Range refused: discard partial data and fall back to one full stream from byte 0 (untested against GitHub).
          this.rangeUnsupported = true;
          this.tailKept = false;
          end = total === undefined ? undefined : total - 1;
          await session.ask({ type: "reset" });
          this.offset = 0;
          this.update({ bytesLoaded: 0, lines: 0, notice: { kind: "range-unsupported" } });
          this.event("range-unsupported", { host: r.finalHost, status: 200 });
        } else if (useRange && r.response.status !== 206) {
          await r.response.body?.cancel();
          throw new Retryable(`status-${r.response.status}`);
        }
        this.event(this.offset > 0 ? "resumed" : "body-request", { host: r.finalHost, status: r.response.status, offset: this.offset });

        const expected = end === undefined ? undefined : end - this.offset + 1;
        let received = 0;
        if (!r.response.body) throw new Retryable("short-body");
        const reader = r.response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          this.check(gen);
          if (done) break;
          // Read the length first: sending transfers (detaches) the buffer.
          const n = value.byteLength;
          if (expected !== undefined && received + n > expected) {
            await reader.cancel();
            await this.incomplete("unexpected-length");
            return;
          }
          await session.send(value);
          this.check(gen);
          received += n;
          this.offset += n;
          this.progress(gen, session);
          this.maybeInjectFault(session);
        }
        if (expected !== undefined && received < expected) throw new Retryable("short-body");
        if (end === undefined) break;
      } catch (error) {
        if (gen !== this.gen) throw new Superseded();
        if (error instanceof WorkerFailed || error instanceof Superseded) throw error;
        if (ac.signal.aborted && this.cancelRequested) {
          this.cancelRequested = false;
          this.update({ status: "cancelled", bytesLoaded: this.offset, lines: await this.availableLines(), notice: undefined });
          this.event("cancelled", { offset: this.offset });
          await new Promise<void>((resolve) => (this.resumeWaiter = resolve));
          this.check(gen);
          this.event("resume-requested", { offset: this.offset });
          this.update({ status: "loading" });
          failures = 0;
          continue;
        }
        if (!(error instanceof Retryable) && !isNetworkError(error)) throw error;
        failures++;
        const cause = error instanceof Retryable ? error.reason : "network";
        this.event("interrupted", { offset: this.offset, detail: cause });
        if (failures > this.limits.maxRetries) {
          await this.incomplete(cause);
          return;
        }
        this.update({ bytesLoaded: this.offset, notice: { kind: "retrying", cause, attempt: failures, of: this.limits.maxRetries, offset: this.offset } });
        await this.sleep(200 * failures);
        this.check(gen);
      }
    }

    const stats = await session.ask<StoreStats>({ type: "finish", appendTail: this.tailKept });
    this.check(gen);
    // Completeness check: total bytes must equal the size the server reported. This is not content verification.
    if (total !== undefined && stats.bytes !== total) {
      this.offset = stats.bytes;
      await this.incomplete("size-mismatch");
      return;
    }
    this.offset = stats.bytes;
    this.update({ status: "complete", bytesLoaded: stats.bytes, bytesTotal: total ?? stats.bytes, lines: stats.lines, crc32: stats.crc32, notice: undefined });
    this.event("complete", { detail: `${stats.bytes} bytes, ${stats.lines} lines` });
  }

  private progress(gen: number, session: WorkerSession): void {
    this.update({ bytesLoaded: this.offset }, true);
    const now = Date.now();
    if (now - this.lastStats < 250) return;
    this.lastStats = now;
    session
      .ask<StoreStats>({ type: "stats" })
      .then((stats) => {
        if (gen === this.gen && this.snap.status === "loading") this.update({ lines: stats.lines }, true);
      })
      .catch(() => {});
  }

  private maybeInjectFault(session: WorkerSession): void {
    if (!__FIXTURE_MODE__) return;
    const faults = this.opts.faults;
    if (!faults || this.faultInjected || this.workersCreated > faults.workerFailures || this.total === undefined) return;
    if (this.offset >= this.total * faults.atFraction) {
      this.faultInjected = true;
      session.post({ type: "inject-failure" });
    }
  }
}
