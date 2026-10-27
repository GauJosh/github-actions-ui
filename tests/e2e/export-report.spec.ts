// Export of an investigation report (fixture mode, SYNTHETIC runs and evidence only): the preview shows each
// section's real state, the file is built from what the page already holds (no request), validated, and saved locally.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { InvestigationReport } from "../../src/domain/report/report";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
const section = (page: Page, name: string) => page.locator(`[data-testid="report-section"][data-section="${name}"]`);

/** Every http(s) request the page makes from now on (fixture API and anything else). */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
}

/** Waits until the page has made no request for 700 ms (no settled-network event is relied on). */
async function settle(page: Page) {
  let last = Date.now();
  const touch = () => (last = Date.now());
  page.on("request", touch);
  page.on("requestfinished", touch);
  await expect.poll(() => Date.now() - last, { timeout: 15_000 }).toBeGreaterThan(700);
  page.off("request", touch);
  page.off("requestfinished", touch);
}

async function download(page: Page) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-report").click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: readFileSync(path!, "utf8") };
}

test("export: preview states follow what the page loaded; no request is made; a valid versioned report downloads", async ({ page }) => {
  const github = await forbidGitHub(page);
  // 990000127: one attempt, five synthetic deployments (one with unreadable statuses) and 104 artifacts.
  await page.goto(synthetic(990000127));
  await page.getByTestId("load-deployments").click();
  await expect(page.getByTestId("deployment")).toHaveCount(5);
  await page.getByTestId("load-artifacts").click();
  await expect(page.getByTestId("artifact")).toHaveCount(104);
  await settle(page);

  const requests = recordRequests(page);
  await page.getByTestId("export-report").click();
  const preview = page.getByTestId("export-preview");
  await expect(preview).toBeVisible();
  await expect(page.getByTestId("export-identity")).toHaveAttribute("data-attempt", "1");
  await expect(section(page, "failures")).toHaveAttribute("data-state", "included");
  await expect(section(page, "comparison")).toHaveAttribute("data-state", "not loaded");
  await expect(section(page, "logExcerpts")).toHaveAttribute("data-state", "not applicable");
  await expect(section(page, "logExcerpts")).toContainText("No log excerpts were included. This does not mean the logs hold no relevant lines");
  // Loaded, but GitHub's data was incomplete: partial, with why.
  await expect(section(page, "deployments")).toHaveAttribute("data-state", "partial");
  await expect(section(page, "deployments")).toContainText("could not be read");
  await expect(section(page, "artifacts")).toHaveAttribute("data-state", "partial");
  await expect(section(page, "artifacts")).toContainText("Only the first 100 of 104 artifacts are included.");
  // Never loaded on this page: said so, and not as an empty finding.
  await expect(section(page, "releases")).toHaveAttribute("data-state", "not loaded");
  await expect(section(page, "releases")).toContainText("Not loaded on this page");
  await expect(preview).toContainText("it is not evidence that none exists");
  await expect(preview).toContainText("It does not establish the cause of a failure.");
  await expect(page.getByTestId("export-invalid")).toHaveCount(0);

  const file = await download(page);
  await expect(page.getByTestId("export-saved")).toBeVisible();
  expect(file.name).toBe("report-fixtures-synthetic-990000127-attempt1.json");
  const report = JSON.parse(file.text) as InvestigationReport;
  expect(report.schema).toBe("gha-ui.investigation-report");
  expect(report.version).toBe(1);
  expect(report.source).toMatchObject({ mode: "fixtures", synthetic: true });
  expect(report.run).toMatchObject({ id: 990000127, latestAttempt: 1, viewedAttempt: 1 });
  expect(report.releases).toEqual({ state: "not loaded" });
  expect(report.comparison).toEqual({ state: "not loaded" });
  expect(report.logExcerpts.state).toBe("not applicable");
  expect(report.deployments.data!.items.length).toBeGreaterThan(0);
  expect(report.artifacts.data!.items).toHaveLength(100);
  expect(report.privacy).toEqual({ tokens: false, fullLogs: false, workflowSource: false, rawResponses: false, downloadUrls: false, excerpts: 0 });
  expect(file.text).not.toMatch(/archive_download_url|authorization|workflowText|Bearer |ghp_|\/zip/i);

  // Exporting made no request at all, to the fixture API or anywhere else.
  expect(requests).toEqual([]);
  expect(github).toEqual([]);
});

test("export: unavailable evidence is unavailable, and an open comparison is included without workflow text", async ({ page }) => {
  await forbidGitHub(page);
  await page.route(/\/actions\/runs\/990000126\/artifacts/, (route) => route.fulfill({ status: 503, json: { message: "synthetic outage" } }));
  // 990000127 compared against 990000126, attempt 1.
  await page.goto(synthetic(990000127, "?view=compare&base=990000126.1"));
  await expect(page.getByTestId("side-base")).toBeVisible();
  await expect(page.getByTestId("side-head")).toBeVisible();
  await settle(page);
  const requests = recordRequests(page);
  await page.getByTestId("export-report").click();
  await expect(section(page, "comparison")).toHaveAttribute("data-state", "included");
  await expect(section(page, "comparison")).toContainText("Against run 990000126, attempt 1");
  const file = await download(page);
  const report = JSON.parse(file.text) as InvestigationReport;
  expect(report.comparison.data!.base).toMatchObject({ id: 990000126, attempt: 1 });
  expect(report.comparison.data!.workflowFile).toBeDefined();
  expect(file.text).not.toMatch(/workflowText|runs-on|make build/);
  expect(requests).toEqual([]);

  // On 990000126 the artifact listing fails: unavailable with the reason, never an empty list.
  await page.goto(synthetic(990000126));
  await page.getByTestId("load-artifacts").click();
  await expect(page.getByTestId("artifacts-listing")).toHaveAttribute("data-state", "unavailable");
  await page.getByTestId("export-report").click();
  await expect(section(page, "artifacts")).toHaveAttribute("data-state", "unavailable");
  await expect(section(page, "comparison")).toHaveAttribute("data-state", "not loaded");
  const other = JSON.parse((await download(page)).text) as InvestigationReport;
  expect(other.artifacts.state).toBe("unavailable");
  expect(other.artifacts.reason).toBeTruthy();
  expect(other.artifacts.data).toBeUndefined();
});

test("export: a report that fails validation cannot be downloaded", async ({ page }) => {
  await forbidGitHub(page);
  // A synthetic run whose title holds credential-shaped text (not a real secret): the report must not be saved.
  await page.route(/\/__fixtures\/api\/repos\/fixtures\/synthetic\/actions\/runs\/990000126$/, async (route) => {
    const response = await route.fetch();
    const run = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...run, display_title: "[synthetic] deploy password=synthetic-not-a-secret" } });
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.goto(synthetic(990000126));
  await page.getByTestId("export-report").click();
  const invalid = page.getByTestId("export-invalid");
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText("did not pass validation");
  await expect(invalid).toContainText("Credential-shaped text at report.run.title.");
  // The error names where, never the text itself.
  await expect(invalid).not.toContainText("synthetic-not-a-secret");
  await expect(page.getByTestId("download-report")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(downloads).toBe(0);
});

test("export: switching attempts or runs never exports stale evidence", async ({ page }) => {
  await forbidGitHub(page);
  // 990000124 is at attempt 2; attempt 1 failed.
  await page.goto(synthetic(990000124, "?attempt=1"));
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 2");
  await page.getByTestId("export-report").click();
  await expect(page.getByTestId("export-identity")).toHaveAttribute("data-attempt", "1");
  await expect(page.getByTestId("export-identity")).toContainText("Attempt 1 of 2 (not the latest)");
  await expect(section(page, "failures")).toContainText("1 failed job");

  // Another attempt: the preview built for attempt 1 closes; a new one describes attempt 2.
  await page.getByTestId("attempt-banner").getByRole("button").click();
  await expect(page.getByTestId("attempt-banner")).toHaveCount(0);
  await expect(page.getByTestId("export-preview")).toHaveCount(0);
  await page.getByTestId("export-report").click();
  await expect(page.getByTestId("export-identity")).toHaveAttribute("data-attempt", "2");
  await expect(section(page, "failures")).toContainText("0 failed jobs");
  const file = await download(page);
  expect(file.name).toBe("report-fixtures-synthetic-990000124-attempt2.json");
  expect((JSON.parse(file.text) as InvestigationReport).run).toMatchObject({ id: 990000124, latestAttempt: 2, viewedAttempt: 2 });

  // Artifacts loaded for 990000127 are not in another run's report, nor in 990000127's once the page no longer shows them.
  await page.goto(synthetic(990000127));
  await page.getByTestId("load-artifacts").click();
  await expect(page.getByTestId("artifact")).toHaveCount(104);
  await page.goto(synthetic(990000126));
  await page.getByTestId("export-report").click();
  await expect(page.getByTestId("export-identity")).toHaveAttribute("data-run", "990000126");
  await expect(section(page, "artifacts")).toHaveAttribute("data-state", "not loaded");
  await page.goto(synthetic(990000127));
  await expect(page.getByTestId("load-artifacts")).toBeVisible();
  await page.getByTestId("export-report").click();
  await expect(page.getByTestId("export-identity")).toHaveAttribute("data-run", "990000127");
  await expect(section(page, "artifacts")).toHaveAttribute("data-state", "not loaded");
  for (const name of ["deployments", "releases", "comparison"]) await expect(section(page, name)).toHaveAttribute("data-state", "not loaded");
});
