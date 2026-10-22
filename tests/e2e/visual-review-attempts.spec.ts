// Review screenshots of run attempts and a deployment-only graph (SYNTHETIC fixtures).
// Output: review-screenshots/attempts/ (git-ignored). Evidence for humans, not pixel assertions.
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1366, height: 900 } });
const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

test("run attempts and a deployment-only run", async ({ page }) => {
  await page.goto(run(990002005, "?attempt=1"));
  await expect(page.getByTestId("attempt-banner")).toBeVisible();
  await expect(page.locator('[data-testid=attempt][data-status="success"]')).toBeVisible();
  await page.screenshot({ path: "review-screenshots/attempts/01-earlier-attempt.png" });
  await page.goto(run(990002006, "?view=graph&attempt=1"));
  await expect(page.locator(".graph-panel [role=alert]")).toBeVisible();
  await page.screenshot({ path: "review-screenshots/attempts/02-attempt-unavailable.png" });
  await page.goto(run(990009001, "?view=graph"));
  await expect(page.getByTestId("graph-viewport")).toBeVisible();
  await page.getByTestId("declared-context").locator("summary").click();
  await page.locator(".explorer").screenshot({ path: "review-screenshots/attempts/03-deploy-only-graph.png" });
});
