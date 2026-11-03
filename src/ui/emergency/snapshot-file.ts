// Security review M5: carry a prepared snapshot between origins as a file, instead of the executor serving the page
// that prepares it. The trusted origin (which holds the GitHub token) prepares and exports the bundle; the operator
// imports the file into the executor console (which never holds the token). The bundle is just data — the executor
// re-validates it on upload (H1), so a tampered file is refused there.
import type { SnapshotBundle } from "../../emergency/snapshot";

const FORMAT = "gha-emergency-snapshot/1";

/** Downloads a prepared bundle as a JSON file (manifest + base64 contents). No network, no token. */
export function exportSnapshotFile(name: string, bundle: SnapshotBundle): void {
  const blob = new Blob([JSON.stringify({ format: FORMAT, ...bundle })], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^\w.-]+/g, "-")}.gha-snapshot.json`;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reads a file the trusted origin exported, with enough validation to reject something that isn't a bundle. */
export async function readSnapshotFile(file: File): Promise<SnapshotBundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file is not a snapshot export (not valid JSON)");
  }
  const o = parsed as { format?: unknown; manifest?: unknown; contents?: unknown };
  if (o.format !== FORMAT || typeof o.manifest !== "object" || o.manifest === null || typeof o.contents !== "object" || o.contents === null) {
    throw new Error("That file is not a snapshot export prepared by the trusted UI");
  }
  return { manifest: o.manifest, contents: o.contents } as SnapshotBundle;
}
