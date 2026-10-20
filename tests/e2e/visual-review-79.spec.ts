// Before/after review of the 79-job synthetic platform release at a normal desktop viewport (1366×900).
// Output: review-screenshots/79-jobs/<REVIEW_LABEL>/ (git-ignored). Evidence for humans, not pixel assertions.
import { expect, test, type Page } from "@playwright/test";

const LABEL = process.env.REVIEW_LABEL ?? "after";
const OUT = `review-screenshots/79-jobs/${LABEL}`;
const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

test.use({ viewport: { width: 1366, height: 900 } });

async function settle(page: Page) {
  await expect(page.locator("#graph")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

test("79-job release: overview, focused phases and raw graph", async ({ page }) => {
  // Failure variant: Billing failed in Stage and was rolled back.
  await page.goto(run(990006002));
  await settle(page);
  await page.screenshot({ path: `${OUT}/01-overview-billing-failed.png` });

  await page.goto(run(990006002, "/phases/stage"));
  await settle(page);
  await page.getByTestId("phase-detail").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/02-stage-phase-focused.png` });

  await page.goto(run(990006002, "/phases/stage"));
  await settle(page);
  await page.getByTestId("phase-detail").locator('[data-node-key="def:smoke-billing-stage"] button').first().click();
  await page.getByTestId("phase-detail").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/03-stage-phase-failed-job-selected.png` });

  await page.goto(run(990006002, "?view=graph"));
  await settle(page);
  await page.screenshot({ path: `${OUT}/04-raw-graph.png` });

  // Rollout variant: Prod in progress.
  await page.goto(run(990006003));
  await settle(page);
  await page.screenshot({ path: `${OUT}/05-overview-rolling-out.png` });

  await page.goto(run(990006003, "/phases/prod"));
  await settle(page);
  await page.getByTestId("phase-detail").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/06-prod-phase-rolling-out.png` });
});
