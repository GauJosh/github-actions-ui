// Typed messages between the main thread and the log worker (A6). ArrayBuffers are always transferred.
import type { StoreStats } from "./store";

export type ToWorker =
  | { type: "tail"; id: number; buf: ArrayBuffer; startsMidLog: boolean }
  | { type: "bytes"; buf: ArrayBuffer }
  | { type: "reset"; id: number }
  | { type: "finish"; id: number; appendTail: boolean }
  | { type: "stats"; id: number }
  | { type: "rows"; id: number; doc: "tail" | "full"; from: number; count: number }
  | { type: "search"; id: number; query: string; cap: number }
  /** Fixture-mode fault injection only (A9 tests); never sent in live mode. */
  | { type: "inject-failure" };

export type TailSummary = { lines: string[]; lineCount: number };
export type RowsResult = { from: number; lines: string[] };
export type SearchResult = { lines: number[]; capped: boolean };

export type FromWorker =
  | { type: "ack"; n: number }
  | { type: "reply"; id: number; value: TailSummary | StoreStats | RowsResult | SearchResult | null };
