// Pipeline-wide search (fixture mode, SYNTHETIC runs only): one field across metadata and logs, what each log
// covered, navigation to the exact log line with the text highlighted, and no leaks between attempts.
import { expect, test } from "@playwright/test";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
const enterprise = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

test("finds a message in a failed job's log and opens the log at that line, highlighted", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto(synthetic(990000108));
  await page.getByRole("tab", { name: "Search" }).click();
  await page.getByTestId("search-input").fill("expected release notes");
  await expect(page).toHaveURL(/\?view=search&q=expected%20release%20notes$/);
  const log = page.locator("[data-testid=search-log]").filter({ hasText: "unit (shard 2)" });
  await expect(log.getByTestId("search-log-coverage")).toHaveText(/searched the complete log \(\d+ lines\)/);
  await expect(log.getByTestId("search-log-count")).toHaveText("1 match");
  // The other failed jobs' logs were searched too, and say so: no match is not the same as not searched.
  const integration = page.locator("[data-testid=search-log]").filter({ hasText: "integration" });
  await expect(integration).toHaveAttribute("data-searched", "yes");
  await expect(integration).toContainText("No match in what was searched.");

  const result = log.getByTestId("search-result");
  await expect(result).toHaveAttribute("data-line", "10");
  await expect(result).toContainText("Run tests"); // the step the line belongs to
  await expect(result.locator("mark")).toHaveText("expected release notes");
  await result.getByRole("link", { name: "L10" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+\/L10\?view=search&q=expected%20release%20notes$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByRole("textbox", { name: "Search log" })).toHaveValue("expected release notes");
  await expect(page.locator(".log-wrap mark").first()).toHaveText(/expected release notes/i);
  expect(github).toEqual([]);
});

test("metadata results: jobs, steps, workflow source and failures, with filters and exact matching", async ({ page }) => {
  await page.goto(synthetic(990000108, "?view=search&q=publish"));
  await expect(page.locator('[data-testid=search-group][data-kind="job"]')).toContainText("publish");
  await expect(page.locator('[data-testid=search-group][data-kind="source"]')).toContainText("make publish");
  await expect(page.locator('[data-testid=search-group][data-kind="failure"]')).toContainText("publish not run because unit failed");

  await page.locator('[data-testid=search-filter][data-filter="source"]').click();
  await expect(page.getByTestId("search-scope")).toContainText("No logs are searched with this filter.");
  await expect(page.locator('[data-testid=search-group][data-kind="job"]')).toHaveCount(0);
  await expect(page.getByTestId("search-logs")).toHaveCount(0);

  await page.locator('[data-testid=search-filter][data-filter="jobs"]').click();
  await page.getByLabel("Match case").check();
  await page.getByTestId("search-input").fill("PUBLISH");
  await expect(page).toHaveURL(/q=PUBLISH$/);
  await expect(page.getByTestId("run-search-summary")).toContainText("0 matches");
});

test("errors filter with no text lists the error lines of each failed log", async ({ page }) => {
  await page.goto(synthetic(990000108, "?view=search"));
  await page.locator('[data-testid=search-filter][data-filter="errors"]').click();
  const unit = page.locator("[data-testid=search-log]").filter({ hasText: "unit (shard 2)" });
  await expect(unit.locator('[data-testid=search-result] .kind').first()).toBeVisible();
  const kinds = await unit.locator("[data-testid=search-result] .kind").allTextContents();
  expect(kinds.length).toBeGreaterThan(0);
  expect(kinds.every((k) => ["error", "error-signature", "test-failed", "error-text"].includes(k))).toBe(true);
});

test("a large log is searched only in its tail, and says so; the full log can be loaded on request", async ({ page }) => {
  await page.goto(synthetic(990000001, "?view=search&q=Error"));
  const log = page.getByTestId("search-log").first();
  await expect(log).toHaveAttribute("data-status", "tail-only", { timeout: 30_000 });
  await expect(log.getByTestId("search-log-coverage")).toContainText("searched only the last");
  await expect(log.getByTestId("search-log-coverage")).toContainText("above the size that loads automatically");
  await expect(log.getByRole("button", { name: "Load and search the full log" })).toBeVisible();
  // Matches in the tail open the job's log (their absolute line is not known yet).
  const first = log.getByTestId("search-result").first();
  await expect(first.getByRole("link", { name: "tail" })).toBeVisible();
});

test("an earlier attempt's expired logs are reported as not searched, and its results never mix with another attempt", async ({ page }) => {
  await page.goto(enterprise(990002005, "?view=search&attempt=1&q=Smoke"));
  const logs = page.getByTestId("search-log");
  await expect(logs.first()).toHaveAttribute("data-status", "expired");
  await expect(logs.first().getByTestId("search-log-coverage")).toContainText("not searched");
  // Every result of attempt 1 links to attempt 1.
  for (const href of await page.locator("[data-testid=search-result] a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""))) {
    if (href) expect(href).toContain("attempt=1");
  }
  // Switching to the latest attempt searches that attempt's own logs.
  await page.locator('[data-testid=attempt][data-attempt="3"]').click();
  await expect(page).toHaveURL(/view=search/);
  await expect(page).not.toHaveURL(/attempt=1/);
});
