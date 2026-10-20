// User-facing wording for every explicit state. Completeness wording never claims verification:
// GitHub publishes no checksum for logs, so the app can only check sizes (docs/ARCHITECTURE.md §6.6).
import { LARGE_LOG_SOFT_LIMIT_BYTES } from "../config";
import type { ApiFailure } from "../domain/types";
import type { LogSnapshot } from "../logs/download/loader";

export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
export const count = (n: number) => n.toLocaleString("en-US");

export function failureText(failure: ApiFailure): string {
  switch (failure.kind) {
    case "auth-failed":
      return "GitHub rejected the token (invalid or expired). Disconnect and paste a new token.";
    case "rate-limited":
      return failure.resetAt
        ? `GitHub rate limit reached. It resets at ${new Date(failure.resetAt).toLocaleTimeString()}.`
        : "GitHub rate limit reached. Try again later.";
    case "permission":
      return `The token lacks permission for this resource: ${failure.detail}`;
    case "not-found-or-no-permission":
      return "Not found, or the token has no access to it. GitHub reports private resources as not found.";
    case "expired":
      return "GitHub no longer retains this data (expired).";
    case "signed-url-rejected":
      return "The log host rejected the download link.";
    case "http-error":
      return `GitHub returned HTTP ${failure.status}.`;
    case "network":
      return "Network error: GitHub could not be reached.";
  }
}

export function logStatusText(s: LogSnapshot): string {
  const total = s.bytesTotal;
  const progress = total !== undefined ? `${mb(s.bytesLoaded)} of ${mb(total)}` : mb(s.bytesLoaded);
  if (s.notice?.kind === "reloading" && (s.status === "tail" || s.status === "loading" || s.status === "sizing")) {
    return `Reloading log after an internal error (restart ${s.notice.restart} of ${s.notice.of}): ${progress}`;
  }
  switch (s.status) {
    case "sizing":
      return "Checking log size…";
    case "tail":
      return "Loading the end of the log first…";
    case "loading":
      if (s.notice?.kind === "retrying") {
        return `Connection interrupted (${s.notice.cause}). Resuming from byte ${count(s.notice.offset)}, attempt ${s.notice.attempt} of ${s.notice.of}.`;
      }
      return `Loading full log: ${progress}`;
    case "cancelled":
      return `Paused at ${progress}. The bytes received are kept.`;
    case "tail-only":
      return `This log is ${total !== undefined ? mb(total) : "large"}, above the ${mb(LARGE_LOG_SOFT_LIMIT_BYTES)} automatic-load limit. Showing the end of the log only. Search and line navigation are unavailable until the full log is loaded.`;
    case "complete":
      return `Download complete (${count(s.bytesLoaded)} bytes, matches the size reported by GitHub).`;
    case "incomplete":
      return `Incomplete: ${count(s.bytesLoaded)} of ${total !== undefined ? count(total) : "?"} bytes received (${s.incompleteCause ?? "interrupted"}).`;
    case "expired":
      return "Logs expired: GitHub no longer retains this log.";
    case "unavailable":
      return "No log available: the job was skipped, or the log was not found.";
    case "processing-failed":
      return "Log processing stopped after repeated internal errors.";
    case "failed":
      return s.failure ? failureText(s.failure) : `Log could not be loaded${s.errorDetail ? `: ${s.errorDetail}` : "."}`;
  }
}
