// Log display preferences: mode, quick filters, context and search options. Kept in memory for the session so they
// carry across jobs and views; never persisted (no-persistence policy, docs/ARCHITECTURE.md §5).
import { useSyncExternalStore } from "react";
import type { FilterKey, LogMode } from "../domain/logs/view";

export type LogPrefs = {
  mode: LogMode;
  filters: FilterKey[];
  context: number;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Show only matching lines (with context). */
  only: boolean;
  /** Search the selected step's lines, when a step is selected and located. */
  scope: "job" | "step";
};

export const DEFAULT_LOG_PREFS: LogPrefs = { mode: "essential", filters: [], context: 3, caseSensitive: false, wholeWord: false, regex: false, only: false, scope: "job" };

let prefs = DEFAULT_LOG_PREFS;
const listeners = new Set<() => void>();

export function setLogPrefs(patch: Partial<LogPrefs>): void {
  prefs = { ...prefs, ...patch };
  listeners.forEach((l) => l());
}

export function useLogPrefs(): LogPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}
