// Security review M5: the per-origin role, injected into index.html by whichever server serves this page
// (deploy/ui/server.mjs). It decides whether this origin may hold the user's GitHub token.
// - "trusted": the full investigation app, GitHub sign-in and snapshot preparation. The GitHub token lives here, on
//   an origin the executor cannot modify (served by the separate gha-ui deployment or any static host).
// - "executor": the emergency execution console, served by the executor. It must never hold the GitHub token: no
//   GitHub sign-in and no preparation; snapshots are imported from a file prepared on the trusted origin.
// - "bundled": single-origin local development — everything on one origin (explicitly not the secure deployment).
// The default is "bundled" so the dev server (which injects nothing) behaves as the all-in-one dev experience.
export type UiRole = "trusted" | "executor" | "bundled";
export type UiConfig = { role: UiRole; trustedUiUrl: string };

function readConfig(): { role?: unknown; trustedUiUrl?: unknown } | undefined {
  // Production: a <meta> the serving origin injected (deploy/ui/server.mjs). Tests: a window global.
  if (typeof document !== "undefined") {
    const content = document.querySelector('meta[name="gha-ui-config"]')?.getAttribute("content");
    if (content) {
      try {
        return JSON.parse(atob(content)) as { role?: unknown; trustedUiUrl?: unknown };
      } catch {
        // fall through to the window global / default
      }
    }
  }
  return (globalThis as { __GHA_UI__?: { role?: unknown; trustedUiUrl?: unknown } }).__GHA_UI__;
}

export function uiConfig(): UiConfig {
  const raw = readConfig();
  const role = raw?.role === "trusted" || raw?.role === "executor" || raw?.role === "bundled" ? raw.role : "bundled";
  const trustedUiUrl = typeof raw?.trustedUiUrl === "string" ? raw.trustedUiUrl : "";
  return { role, trustedUiUrl };
}

/** Whether this origin may sign in to GitHub and hold the token (everything but the executor console). */
export const githubAllowedHere = (role: UiRole = uiConfig().role) => role !== "executor";
