// Review screenshots of the grouped execution graph (SYNTHETIC fixtures). Output: review-screenshots/graph/ (git-ignored).
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1366, height: 900 } });
const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

test("grouped execution graph: promotion checks, shared CI/CD, platform", async ({ page }) => {
  for (const [id, name] of [
    [990008002, "01-promotion-checks"],
    [990007002, "02-shared-cicd"],
    [990006002, "03-platform"],
  ] as const) {
    await page.goto(run(id, "?view=graph"));
    await expect(page.getByTestId("group-frame").first()).toBeVisible();
    await page.getByRole("button", { name: "Fit" }).click();
    await page.locator(".graph-panel, [data-testid=graph-viewport]").first().screenshot({ path: `review-screenshots/graph/${name}.png` });
  }
  await page.goto(run(990008001));
  await page.getByTestId("release-overview").screenshot({ path: "review-screenshots/graph/04-overview.png" });
});
