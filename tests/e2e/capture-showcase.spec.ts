// Regenerates the landing page's showcase screenshots (src/ui/assets/showcase-*.png) from the app itself, on a
// SYNTHETIC demo run. Runs only with CAPTURE_SHOWCASE=1, then rebuild: `CAPTURE_SHOWCASE=1 npx playwright test capture-showcase`.
import { expect, test } from "@playwright/test";

test.skip(!process.env.CAPTURE_SHOWCASE, "set CAPTURE_SHOWCASE=1 to regenerate the showcase screenshots");
test.use({ viewport: { width: 1440, height: 1800 }, deviceScaleFactor: 1.5 });

for (const scheme of ["light", "dark"] as const) {
  test(`showcase (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/?mode=fixtures#/runs/fixtures/enterprise/990008002?view=graph");
    const viewport = page.getByTestId("graph-viewport");
    await expect(viewport).toBeVisible();
    await page.getByRole("button", { name: "Expand" }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Fit" }).click();
    await page.waitForTimeout(300);
    // Every frame must be inside the canvas; zoom out until it is.
    const frames = () => page.getByTestId("group-frame").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    const inside = async () => {
      const v = (await viewport.boundingBox())!;
      return (await frames()).every((b) => b.y >= v.y && b.y + b.height <= v.y + v.height && b.x >= v.x && b.x + b.width <= v.x + v.width);
    };
    for (let i = 0; i < 6 && !(await inside()); i++) {
      await page.getByRole("button", { name: "Zoom out" }).click();
      await page.waitForTimeout(200);
    }
    expect(await inside()).toBe(true);
    // Cropped to the drawn graph (its frames), with a margin of the canvas around it.
    const boxes = await frames();
    const [x0, y0] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
    const [x1, y1] = [Math.max(...boxes.map((b) => b.x + b.width)), Math.max(...boxes.map((b) => b.y + b.height))];
    const pad = 20;
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.screenshot({
      path: `src/ui/assets/showcase-${scheme}.png`,
      fullPage: true,
      clip: { x: x0 - pad, y: y0 + scrollY - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad },
    });
  });
}
