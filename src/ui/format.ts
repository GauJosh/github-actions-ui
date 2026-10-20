// Formatting helpers. Durations are only shown when both real timestamps exist.

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const diff = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(diff)) return "";
  if (diff < 45) return "just now";
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (Math.abs(diff) >= size) {
      const n = Math.round(diff / size);
      return diff > 0 ? `${n} ${name}${n === 1 ? "" : "s"} ago` : `in ${-n} ${name}${n === -1 ? "" : "s"}`;
    }
  }
  return "just now";
}

export const absoluteTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");
export const shortSha = (sha: string) => sha.slice(0, 7);
export const firstLine = (text: string | null | undefined) => (text ?? "").split("\n")[0]!.trim();
