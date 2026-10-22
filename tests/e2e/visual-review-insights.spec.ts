// Review screenshots of run statistics, the timeline and the workflow source explorer (SYNTHETIC fixtures).
// Output: review-screenshots/insights/ (git-ignored). Evidence for humans, not pixel assertions.
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1366, height: 900 } });
const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

test("run insights: statistics, timeline, workflow source", async ({ page }) => {
  await page.goto(run(990008002, "?view=timeline"));
  await expect(page.getByTestId("timeline")).toBeVisible();
  await page.getByTestId("timeline-row").filter({ hasText: "PROD-DR validation" }).getByRole("button").first().click();
  await page.locator(".explorer").screenshot({ path: "review-screenshots/insights/01-timeline.png" });
  await page.goto(run(990007002, "?view=source"));
  await expect(page.getByTestId("source-explorer")).toBeVisible();
  await page.getByTestId("source-file").filter({ hasText: "DEV" }).click();
  await page.locator(".explorer").screenshot({ path: "review-screenshots/insights/02-source.png" });
});
