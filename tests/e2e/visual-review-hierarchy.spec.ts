// Review screenshots of the SYNTHETIC shared CI/CD scenario (nested reusable workflows, no phase file).
// Output: review-screenshots/hierarchy/ (git-ignored). Evidence for humans, not pixel assertions.
import { expect, test } from "@playwright/test";

const OUT = "review-screenshots/hierarchy";
const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;
test.use({ viewport: { width: 1366, height: 900 } });

test("shared CI/CD: overview, DEV phase, failed job and raw graph", async ({ page }) => {
  await page.goto(run(990007002));
  await expect(page.getByTestId("phase-rail")).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-overview-cd-policy-failed.png`, fullPage: true });

  await page.getByRole("button", { name: "Show the failed job" }).click();
  await expect(page.getByTestId("job-details")).toBeVisible();
  await page.getByTestId("phase-detail").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/02-dev-phase-failed-job.png`, fullPage: true });

  await page.goto(run(990007002, "?view=graph"));
  await expect(page.getByTestId("graph-viewport")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/03-raw-graph.png`, fullPage: true });

  await page.goto(run(990007003));
  await expect(page.getByTestId("graph-viewport")).toBeVisible();
  await page.screenshot({ path: `${OUT}/04-revision-unresolved.png`, fullPage: true });
});
