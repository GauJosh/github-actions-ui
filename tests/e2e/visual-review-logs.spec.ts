// Review screenshots of the log viewer's display modes (SYNTHETIC fixture logs) at a desktop viewport.
// Output: review-screenshots/logs/ (git-ignored). Evidence for humans, not pixel assertions.
import { expect, test } from "@playwright/test";

const OUT = "review-screenshots/logs";
test.use({ viewport: { width: 1366, height: 900 } });

test("log viewer: essential, all output, errors & warnings, filters and search", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/enterprise/990006002");
  await page.getByRole("button", { name: "Show the failed job" }).click();
  await page.getByTestId("failed-step-link").click();
  const panel = page.locator(".log-panel");
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", "found");
  await expect(page.locator(".row.highlighted")).toBeVisible();
  await panel.screenshot({ path: `${OUT}/01-essential-failed-step.png` });

  await page.getByRole("tab", { name: "All output" }).click();
  await panel.screenshot({ path: `${OUT}/02-all-output.png` });

  await page.getByRole("tab", { name: "Errors & warnings" }).click();
  await panel.screenshot({ path: `${OUT}/03-errors-and-warnings.png` });

  await page.getByRole("tab", { name: "Essential output" }).click();
  await page.getByRole("group", { name: "Quick filters" }).locator('[data-filter="commands"]').click();
  await page.getByLabel("Search log").fill("deploy");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("search-summary")).toBeVisible();
  await panel.screenshot({ path: `${OUT}/04-filter-and-search.png` });

  // A real runner log (public fixture s05): setup preamble, checkout, Python steps.
  await page.goto("/?mode=fixtures#/runs/GauJosh/gha-ui-fixtures/39366120652");
  await page.locator('[data-node-key="def:build"]').getByRole("button").first().click();
  await page.getByTestId("job-details").getByTestId("open-log").click();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  await page.locator(".log-panel").screenshot({ path: `${OUT}/05-real-runner-log-essential.png` });
});
