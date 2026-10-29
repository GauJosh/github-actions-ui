// Writes the headers the production server sends (deploy/ui/server.mjs) from their single source,
// tools/vite/security-headers.ts. Run at image build time: node deploy/ui/write-security-headers.ts <out.json>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_CSP, COMMON_HEADERS, WORKER_CSP } from "../../tools/vite/security-headers.ts";

export const serverHeaders = () => ({ app: APP_CSP, worker: WORKER_CSP, common: { ...COMMON_HEADERS } });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: node deploy/ui/write-security-headers.ts <out.json>");
  writeFileSync(out, `${JSON.stringify(serverHeaders(), null, 2)}\n`);
}
