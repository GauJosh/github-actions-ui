// Review screenshots for the visual refinement (SYNTHETIC fixtures only), in light and dark, at a desktop and a
// phone size. Output: review-screenshots/refine/<SHOTS or "current">/ (git-ignored). Evidence for humans, not
// pixel assertions.
import { expect, test, type Page } from "@playwright/test";

const dir = `review-screenshots/refine/${process.env.SHOTS ?? "current"}`;
const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });

    test(`landing and token entry (${scheme})`, async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("token-input")).toBeVisible();
      await shot(page, `${scheme}-01-landing`);
      await shot(page, `${scheme}-01-landing-full`, true);
    });

    test(`repository and demo selection (${scheme})`, async ({ page }) => {
      await page.goto("/?mode=fixtures");
      await expect(page.getByTestId("demo-gallery")).toBeVisible();
      await shot(page, `${scheme}-02-home`);
    });

    test(`release overview (${scheme})`, async ({ page }) => {
      await page.goto(run(990006002));
      await expect(page.locator("[data-phase-status]").first()).toBeVisible();
      await shot(page, `${scheme}-03-overview`);
    });

    test(`execution graph with a failure (${scheme})`, async ({ page }) => {
      await page.goto(run(990008002, "?view=graph"));
      await expect(page.getByTestId("graph-viewport")).toBeVisible();
      await page.locator('[data-testid=graph-node][data-status="failure"] button').first().click();
      await shot(page, `${scheme}-04-graph`);
    });

    test(`timeline (${scheme})`, async ({ page }) => {
      await page.goto(run(990008002, "?view=timeline"));
      await expect(page.getByTestId("timeline")).toBeVisible();
      await shot(page, `${scheme}-05-timeline`);
    });

    test(`workflow source and log investigation (${scheme})`, async ({ page }) => {
      await page.goto(run(990007002, "?view=source"));
      await expect(page.getByTestId("source-explorer")).toBeVisible();
      await page.getByTestId("source-file").filter({ hasText: /^DEV / }).click();
      await shot(page, `${scheme}-06-source`);
      await page.goto(run(990006002));
      await page.getByRole("button", { name: "Show the failed job" }).click();
      await page.getByTestId("job-details").getByTestId("open-log").click();
      await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
      await page.getByTestId("job-details").scrollIntoViewIfNeeded();
      await shot(page, `${scheme}-06-log`);
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  test("landing and a run on a phone", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("token-input")).toBeAttached();
    await shot(page, "phone-01-landing", true);
    await page.goto(run(990008002, "?view=graph"));
    await expect(page.getByTestId("graph-viewport")).toBeVisible();
    await shot(page, "phone-04-graph");
  });
});
