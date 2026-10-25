// Review screenshots for comparison, pipeline-wide search and log comparison (SYNTHETIC fixtures only).
// Output: review-screenshots/investigate/ (git-ignored). Evidence for humans, not pixel assertions.
import { expect, test } from "@playwright/test";

const url = (rest: string) => `/?mode=fixtures#/runs/fixtures/synthetic/990000108${rest}`;
const dir = "review-screenshots/investigate";

for (const scheme of ["light", "dark"] as const) {
  test(`comparison and search (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(url("?view=compare"));
    await expect(page.getByTestId("baseline-picker")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${scheme}-picker.png`, fullPage: true });
    await page.getByTestId("use-suggested").click();
    await expect(page.getByTestId("compare-summary")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${scheme}-compare.png`, fullPage: true });
    await page.locator('[data-testid=compare-job][data-change=outcome]').first().getByTestId("compare-logs").click();
    await expect(page.getByTestId("logcmp-summary")).toBeVisible();
    await page.getByTestId("log-compare").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${scheme}-logcmp.png`, fullPage: true });
    await page.goto(url("?view=search&q=release"));
    await expect(page.getByTestId("run-search-summary")).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/${scheme}-search.png`, fullPage: true });
  });
}

test("phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("?view=compare&base=990000109.1"));
  await expect(page.getByTestId("compare-summary")).toBeVisible();
  await page.screenshot({ path: `${dir}/phone-compare.png`, fullPage: true });
  await page.goto(url("?view=search&q=Error"));
  await expect(page.getByTestId("run-search-summary")).toBeVisible();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${dir}/phone-search.png`, fullPage: true });
});
