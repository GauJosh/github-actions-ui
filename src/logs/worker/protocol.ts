// Typed messages between the main thread and the log worker (A6). ArrayBuffers are always transferred.
import type { LineKind } from "../../domain/logs/classify";
import type { FindResult, Fingerprints, LogDiff } from "../../domain/logs/queries";
import type { SearchOptions, ViewRow, ViewSpec, ViewSummary } from "../../domain/logs/view";
import type { LogMarkers } from "../../domain/steps/step-map";
import type { StoreStats } from "./store";

export type ToWorker =
  | { type: "tail"; id: number; buf: ArrayBuffer; startsMidLog: boolean }
  | { type: "bytes"; buf: ArrayBuffer }
  | { type: "reset"; id: number }
  | { type: "finish"; id: number; appendTail: boolean }
  | { type: "stats"; id: number }
  | { type: "rows"; id: number; doc: "tail" | "full"; from: number; count: number }
  | { type: "search"; id: number; query: string; cap: number }
  /** Step markers and error lines of the full log, for step mapping (docs/ARCHITECTURE.md §8). */
  | { type: "markers"; id: number }
  /** Builds the display view (mode, filters, search) over the full log's lines so far (docs/ARCHITECTURE.md §8.1). */
  | { type: "view"; id: number; spec: ViewSpec }
  /** Rows of the current view; empty when `version` is no longer current. */
  | { type: "view-rows"; id: number; version: number; from: number; count: number }
  /** Pipeline-wide search: matching lines (optionally of some kinds) with short excerpts, in the tail or full log. */
  | { type: "find"; id: number; doc: "tail" | "full"; search: SearchOptions; kinds?: LineKind[]; cap: number }
  /** Log comparison: normalised line fingerprints of the full log (or a range of it). */
  | { type: "fingerprint"; id: number; essential: boolean; range?: [number, number] }
  /** Log comparison: the diff of another log's fingerprints against this log, computed here (off the main thread). */
  | { type: "diff"; id: number; other: Uint32Array; essential: boolean; range?: [number, number]; maxEdits: number }
  /** Fixture-mode fault injection only (A9 tests); never sent in live mode. */
  | { type: "inject-failure" };

export type TailSummary = { lines: string[]; lineCount: number };
export type RowsResult = { from: number; lines: string[] };
export type SearchResult = { lines: number[]; capped: boolean };
export type ViewRowsResult = { version: number; from: number; rows: ViewRow[] };

export type FromWorker =
  | { type: "ack"; n: number }
  | {
      type: "reply";
      id: number;
      value: TailSummary | StoreStats | RowsResult | SearchResult | LogMarkers | ViewSummary | ViewRowsResult | FindResult | Fingerprints | LogDiff | null;
    };
