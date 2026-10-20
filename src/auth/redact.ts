// Scrubs anything credential-shaped from text before it is shown or recorded.

const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const BEARER = /\b(Bearer|token)\s+[A-Za-z0-9_\-.=]{8,}/gi;
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s"'<>?#]+[?#][^\s"'<>]*/g;

export function redact(text: string): string {
  return text
    .replace(URL_WITH_QUERY, (url) => url.replace(/[?#].*$/, "?[redacted]"))
    .replace(TOKEN, "[redacted-token]")
    .replace(BEARER, "$1 [redacted]");
}

/** Host of a URL, or "unknown". Used instead of full URLs everywhere a response location is recorded. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "unknown";
  }
}
