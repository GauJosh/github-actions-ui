import { expect, test } from "@playwright/test";
import { APP_CSP, WORKER_CSP } from "../../tools/vite/security-headers.ts";
import { S09, cspViolations, diagnosticEvents, forbidGitHub, instrument, responsiveness, s09Expectations, statusTexts } from "./support";

const s09Hash = `#/runs/${S09.owner}/${S09.repo}/${S09.runId}`;

test("s09 in fixture mode: failed job from API data, tail first, complete log, search and deep links", async ({ page }) => {
  const expected = s09Expectations();
  const github = await forbidGitHub(page);
  await instrument(page);
  const headers = new Map<string, string | undefined>();
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (path === "/" || /log-worker-/.test(path)) headers.set(path === "/" ? "document" : "worker", r.headers()["content-security-policy"]);
  });

  await page.goto("/?mode=fixtures");
  await expect(page.getByTestId("fixture-banner")).toContainText("No requests go to GitHub");
  await page.getByLabel("GitHub Actions run URL").fill(`https://github.com/${S09.owner}/${S09.repo}/actions/runs/${S09.runId}`);
  await page.getByRole("button", { name: "Open run" }).click();

  await expect(page.getByTestId("failed-jobs")).toContainText("noisy");
  await expect(page.getByTestId("failed-jobs")).toContainText("Step 2: Generate large noisy log");

  const status = page.getByTestId("log-status");
  await expect(status).toHaveAttribute("data-status", "complete", { timeout: 60_000 });
  await expect(status).toContainText(`Download complete (${expected.bytes.toLocaleString("en-US")} bytes, matches the size reported by GitHub)`);
  await expect(page.locator("body")).not.toContainText(/verified/i);
  const perf = await responsiveness(page);
  test.info().annotations.push({ type: "responsiveness (trend, non-blocking)", description: JSON.stringify(perf) });
  console.log(`s09 responsiveness: ${JSON.stringify(perf)}`);

  const events = await diagnosticEvents(page);
  expect(events.indexOf("tail-ready")).toBeGreaterThan(-1);
  expect(events.indexOf("tail-ready")).toBeLessThan(events.indexOf("body-request"));
  expect(events.indexOf("body-request")).toBeLessThan(events.indexOf("complete"));
  expect((await statusTexts(page)).some((t) => t.startsWith("Loading the end of the log first"))).toBe(true);
  // Regression check against the pinned fixture: catches lost, duplicated or reordered bytes.
  await expect(page.getByTestId("diag-crc32")).toHaveText(expected.crc32Hex);

  await page.getByLabel("Search log").fill("checksum mismatch");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("search-summary")).toHaveText(`${expected.hits.length} matching lines`);
  const last = expected.hits.at(-1)!;
  await page.getByTestId("search-hits").getByRole("link", { name: `Line ${last}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${S09.jobId}/L${last}$`));
  const row = page.locator(`[data-line="${last}"]`);
  await expect(row).toHaveClass(/highlighted/);
  await expect(row).toContainText("checksum mismatch");

  // A deep link opened directly scrolls to and highlights the line once it has loaded.
  await page.goto(`/?mode=fixtures${s09Hash}/jobs/${S09.jobId}/L${expected.hits[0]}`);
  await expect(page.locator(`[data-line="${expected.hits[0]}"]`)).toHaveClass(/highlighted/, { timeout: 60_000 });

  // The worker cannot make network requests (connect-src 'none'), checked inside the worker itself.
  const worker = page.workers().find((w) => /log-worker-/.test(w.url()));
  expect(worker).toBeDefined();
  expect(await worker!.evaluate(() => fetch("/").then(() => "allowed", () => "blocked"))).toBe("blocked");

  expect(headers.get("document")).toBe(APP_CSP);
  expect(headers.get("worker")).toBe(WORKER_CSP);
  expect((await cspViolations(page)).filter((v) => !v.startsWith("connect-src"))).toEqual([]);
  expect(github).toEqual([]);
});

test("A8: a log above the soft limit stops at the tail; the full log loads only on request", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000001");
  const status = page.getByTestId("log-status");
  await expect(status).toHaveAttribute("data-status", "tail-only", { timeout: 30_000 });
  await expect(status).toContainText("This log is 46.0 MB, above the 44.0 MB automatic-load limit");
  await expect(page.getByTestId("tail-evidence")).toContainText("Synthetic failure: expected 1 but got 2");
  await expect(page.getByText("Search: unavailable until the full log is loaded")).toBeVisible();
  await expect(page.getByLabel("Search log")).toHaveCount(0);
  await expect(page.getByTestId("log-view")).toHaveCount(0);

  await page.getByRole("button", { name: /Load full log \(46\.0 MB\)/ }).click();
  await expect(status).toHaveAttribute("data-status", "complete", { timeout: 90_000 });
  await expect(status).toContainText("Download complete (46,000,000 bytes, matches the size reported by GitHub)");
  await expect(page.getByLabel("Search log")).toBeVisible();
  expect(github).toEqual([]);
});

test("A9: a worker failure reloads from the start with visible progress and ends complete", async ({ page }) => {
  const expected = s09Expectations();
  await instrument(page);
  await page.goto(`/?mode=fixtures&fixture-faults=worker-failures-1${s09Hash}`);
  const status = page.getByTestId("log-status");
  await expect(status).toHaveAttribute("data-status", "complete", { timeout: 90_000 });
  expect((await statusTexts(page)).some((t) => t.startsWith("Reloading log after an internal error (restart 1 of 2)"))).toBe(true);
  expect(await diagnosticEvents(page)).toEqual(expect.arrayContaining(["worker-failed", "reloading", "complete"]));
  await expect(page.getByTestId("diag-crc32")).toHaveText(expected.crc32Hex);
});

test("A9: repeated worker failures end in a recoverable error state, and Retry recovers", async ({ page }) => {
  const expected = s09Expectations();
  await page.goto(`/?mode=fixtures&fixture-faults=worker-failures-3${s09Hash}`);
  const status = page.getByTestId("log-status");
  await expect(status).toHaveAttribute("data-status", "processing-failed", { timeout: 90_000 });
  await expect(status).toContainText("Log processing stopped after repeated internal errors.");
  await expect(page.getByRole("link", { name: "Open log on GitHub" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(status).toHaveAttribute("data-status", "complete", { timeout: 90_000 });
  await expect(page.getByTestId("diag-crc32")).toHaveText(expected.crc32Hex);
});
