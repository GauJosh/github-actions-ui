import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync, crc32 } from "node:zlib";

export const FIXTURE_COMMIT = (JSON.parse(readFileSync("fixtures.lock.json", "utf8")) as { commit: string }).commit;

export const S09 = { owner: "GauJosh", repo: "gha-ui-fixtures", runId: 39366140909, jobId: 118443320691 };

/** Expected values computed from the pinned fixture itself (regression checks, not verification of live logs). */
export function s09Expectations() {
  const log = gunzipSync(readFileSync(`.fixtures/${FIXTURE_COMMIT}/fixtures/GauJosh__gha-ui-fixtures/${S09.runId}/logs/${S09.jobId}.log.gz`));
  const lines = log.toString("utf8").split("\n");
  const hits = lines.flatMap((l, i) => (l.includes("checksum mismatch") ? [i + 1] : []));
  return { bytes: log.byteLength, crc32Hex: crc32(log).toString(16).padStart(8, "0"), hits };
}

/** Records CSP violations and every status text the log panel shows, from before any page script runs. */
export async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[]; __statusTexts: Set<string>; __longTasks: number[]; __maxLate: number };
    w.__csp = [];
    w.__statusTexts = new Set();
    w.__longTasks = [];
    w.__maxLate = 0;
    new PerformanceObserver((list) => list.getEntries().forEach((e) => w.__longTasks.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true });
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      w.__maxLate = Math.max(w.__maxLate, now - last - 10);
      last = now;
    }, 10);
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="log-status"]');
      if (el?.textContent) w.__statusTexts.add(el.textContent);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

/** Main-thread responsiveness while loading: long tasks (>50 ms) and the worst 10 ms-timer lateness. A trend, not a gate. */
export const responsiveness = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[]; __maxLate: number };
    return { longTasks: w.__longTasks.length, longestTaskMs: Math.max(0, ...w.__longTasks), worstTimerLatenessMs: Math.round(w.__maxLate) };
  });

export const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
export const statusTexts = (page: Page) => page.evaluate(() => [...(window as unknown as { __statusTexts: Set<string> }).__statusTexts]);

export async function diagnosticEvents(page: Page): Promise<string[]> {
  const details = page.locator("details.diagnostics");
  if (!(await details.getAttribute("open"))) await details.locator("summary").click();
  return page.getByTestId("diag-events").locator("li").evaluateAll((els) => els.map((e) => e.getAttribute("data-event") ?? ""));
}

/** Fails the test if fixture mode ever tries to reach GitHub. */
export async function forbidGitHub(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com|blob\.core\.windows\.net)\//, (route) => {
    attempts.push(new URL(route.request().url()).host);
    return route.abort();
  });
  return attempts;
}
