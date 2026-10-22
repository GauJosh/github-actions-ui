// Moving around a large graph (SYNTHETIC fixture): pan buttons, keyboard, and dragging that never gets stuck.
import { expect, test, type Page } from "@playwright/test";

const translate = async (page: Page) => {
  const t = await page.locator(".graph-stage").evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]) };
};

test.use({ viewport: { width: 1366, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/enterprise/990006001?view=graph");
  await expect(page.getByTestId("graph-viewport")).toBeVisible();
  await page.getByTestId("graph-viewport").evaluate((el) => el.scrollIntoView({ block: "center" }));
});

test("pan buttons move the view by a fixed step in each direction; the centre fits", async ({ page }) => {
  const start = await translate(page);
  await page.getByRole("button", { name: "Pan right" }).click();
  const right = await translate(page);
  expect(right.x).toBeLessThan(start.x);
  expect(start.x - right.x).toBeGreaterThanOrEqual(60);
  expect(start.x - right.x).toBeLessThanOrEqual(180);
  expect(right.y).toBe(start.y);
  await page.getByRole("button", { name: "Pan left" }).click();
  expect((await translate(page)).x).toBe(start.x);
  await page.getByRole("button", { name: "Pan down" }).click();
  expect((await translate(page)).y).toBeLessThan(start.y);
  await page.getByRole("button", { name: "Pan up" }).click();
  expect((await translate(page)).y).toBe(start.y);
  // Pressing a pan button does not start a drag or select anything.
  await expect(page).not.toHaveURL(/\/jobs\//);
  await page.getByRole("button", { name: "Show the whole graph" }).click();
  await expect(page.locator(".zoom-level")).not.toHaveText("100%");
});

test("arrow keys use the same step as the buttons", async ({ page }) => {
  const start = await translate(page);
  await page.getByTestId("graph-viewport").focus();
  await page.keyboard.press("ArrowRight");
  const key = await translate(page);
  await page.getByRole("button", { name: "Pan left" }).click();
  await page.getByRole("button", { name: "Pan right" }).click();
  expect((await translate(page)).x).toBe(key.x);
  expect(key.x).toBeLessThan(start.x);
});

test("dragging works when it starts on a job, does not select it, and stops when the button is released anywhere", async ({ page }) => {
  // A job fully inside the visible canvas.
  const vp = (await page.getByTestId("graph-viewport").boundingBox())!;
  const nodes = page.locator("[data-testid=graph-node]");
  let index = 0;
  for (; index < (await nodes.count()); index++) {
    const b = (await nodes.nth(index).boundingBox())!;
    if (b.x > vp.x + 160 && b.y > vp.y && b.x + b.width < vp.x + vp.width - 120 && b.y + 40 < vp.y + vp.height) break;
  }
  const node = nodes.nth(index);
  const box = (await node.boundingBox())!;
  const start = await translate(page);
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + 12, { steps: 6 });
  await page.mouse.up();
  const after = await translate(page);
  expect(start.x - after.x).toBeGreaterThan(100);
  await expect(page).not.toHaveURL(/\/jobs\//);
  // After release the view no longer follows the pointer.
  await page.mouse.move(box.x - 200, box.y + 100, { steps: 4 });
  expect(await translate(page)).toEqual(after);
  // A plain click on a job still selects it.
  await node.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/jobs\/\d+/);
});

test("a drag whose release the viewport never saw (button already up) ends instead of sticking", async ({ page }) => {
  const vp = (await page.getByTestId("graph-viewport").boundingBox())!;
  const [x, y] = [vp.x + vp.width - 60, vp.y + 40];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 80, y, { steps: 4 });
  const during = await translate(page);
  // Simulate the release happening outside the page: a move with no buttons pressed.
  await page.getByTestId("graph-viewport").dispatchEvent("pointermove", { clientX: x - 300, clientY: y, buttons: 0, pointerId: 1, isPrimary: true });
  await page.getByTestId("graph-viewport").dispatchEvent("pointermove", { clientX: x - 400, clientY: y, buttons: 1, pointerId: 1, isPrimary: true });
  expect(await translate(page)).toEqual(during);
  await expect(page.getByTestId("graph-viewport")).not.toHaveClass(/panning/);
  await page.mouse.up();
});
