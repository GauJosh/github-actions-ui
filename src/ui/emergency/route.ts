// Emergency execution routes (#/emergency…). Kept apart from the views so the app shell can route without loading
// the emergency code, which is a separate chunk (src/ui/App.tsx).
export type EmergencyRoute = { page: "home" } | { page: "prepare" } | { page: "admin" } | { page: "sign-in-failed" } | { page: "snapshot"; id: string } | { page: "execution"; id: string };

export function parseEmergencyHash(hash: string): EmergencyRoute | null {
  const h = hash.replace(/^#/, "");
  if (h === "/emergency" || h === "/emergency/") return { page: "home" };
  if (h === "/emergency/prepare") return { page: "prepare" };
  if (h === "/emergency/admin") return { page: "admin" };
  if (h === "/emergency/sign-in-failed") return { page: "sign-in-failed" };
  let m = /^\/emergency\/snapshots\/([0-9a-f]{64})$/.exec(h);
  if (m) return { page: "snapshot", id: m[1]! };
  m = /^\/emergency\/executions\/([0-9a-f]{16})$/.exec(h);
  if (m) return { page: "execution", id: m[1]! };
  return null;
}

export const emergencyHref = (r: EmergencyRoute) =>
  r.page === "snapshot" ? `#/emergency/snapshots/${r.id}` : r.page === "execution" ? `#/emergency/executions/${r.id}` : r.page === "home" ? "#/emergency" : `#/emergency/${r.page}`;
