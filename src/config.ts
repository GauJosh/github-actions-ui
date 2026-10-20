// Tunable limits. Each value is documented in docs/ARCHITECTURE.md §6.

/** A8 (provisional): above this size the full log is loaded only on request. A UX policy, not a memory limit. */
export const LARGE_LOG_SOFT_LIMIT_BYTES = 44_000_000;
/** A9: automatic worker restarts per log before the recoverable `processing-failed` state. */
export const MAX_WORKER_RESTARTS = 2;
/** Size of the tail range fetched first. */
export const TAIL_BYTES = 256 * 1024;
/** Credit-based backpressure: pause reading above HIGH un-acknowledged bytes, resume at or below LOW. */
export const BACKPRESSURE_HIGH_BYTES = 8 * 1024 * 1024;
export const BACKPRESSURE_LOW_BYTES = 4 * 1024 * 1024;
/** Retries after consecutive failed attempts (each a new API request) before a log is marked incomplete. */
export const MAX_DOWNLOAD_RETRIES = 3;
/** Lines of the tail shown as early evidence. */
export const TAIL_PREVIEW_LINES = 200;
