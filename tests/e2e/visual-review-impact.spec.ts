// Review screenshots for the failure impact explorer (SYNTHETIC fixtures only), light and dark, desktop and phone.
// Output: review-screenshots/impact/ (git-ignored). Evidence for humans, not pixel assertions.
import { expect, test } from "@playwright/test";

const url = (rest: string) => `/?mode=fixtures#/runs/fixtures/synthetic/990000108${rest}`;

for (const scheme of ["light", "dark"] as const) {
  test(`failure impact (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(url("?view=graph&impact=all"));
    await expect(page.getByTestId("failure-impact")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `review-screenshots/impact/${scheme}-all.png`, fullPage: true });
    await page.locator('[data-testid=impact-pick][data-key="def:integration"]').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `review-screenshots/impact/${scheme}-one.png`, fullPage: true });
  });
}

test("failure impact (phone)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("?view=graph&impact=all"));
  await expect(page.getByTestId("failure-impact")).toBeVisible();
  await page.screenshot({ path: "review-screenshots/impact/phone.png", fullPage: true });
});
