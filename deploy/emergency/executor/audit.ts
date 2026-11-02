// The executor's audit log (security review H2): one JSON line per security-relevant event, attributed to the
// authenticated identity that caused it, written to the executor's volume (<data>/audit/<yyyy-mm>.jsonl, append-only
// from the API's point of view) and to stdout for the cluster's log collection. Never contains secret values,
// session tokens, event keys or the GitHub token.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AuditEntry = { at: string; action: string; [k: string]: unknown };

export function createAuditLog(dataDir: string, deps: { now?: () => Date; stdout?: (line: string) => void } = {}) {
  const dir = join(dataDir, "audit");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = deps.now ?? (() => new Date());
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  return {
    write(entry: Record<string, unknown>): void {
      const at = now().toISOString();
      const line = JSON.stringify({ at, ...entry });
      appendFileSync(join(dir, `${at.slice(0, 7)}.jsonl`), `${line}\n`, { mode: 0o600 });
      stdout(JSON.stringify({ audit: true, ...JSON.parse(line) }));
    },
    /** The most recent entries, newest first. */
    recent(limit = 200): AuditEntry[] {
      const out: AuditEntry[] = [];
      for (const f of readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse()) {
        const p = join(dir, f);
        if (!existsSync(p)) continue;
        const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).reverse();
        for (const l of lines) {
          out.push(JSON.parse(l) as AuditEntry);
          if (out.length >= limit) return out;
        }
      }
      return out;
    },
  };
}

export type AuditLog = ReturnType<typeof createAuditLog>;
