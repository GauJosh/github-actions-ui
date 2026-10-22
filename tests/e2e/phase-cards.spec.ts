// Phase cards adapt to their content (SYNTHETIC fixtures): a longer phase name (e.g. PROD-DR) widens its card
// instead of wrapping or overflowing, and every card's badge and progress bar stay on the same rows.
import { expect, test, type Page } from "@playwright/test";

async function checkCards(page: Page) {
  const cards = page.getByTestId("phase-rail").locator(".phase-card");
  await expect(cards.first()).toBeVisible();
  const m = await cards.evaluateAll((els) =>
    els.map((card) => {
      const r = card.getBoundingClientRect();
      const name = card.querySelector(".pc-name") as HTMLElement | null;
      const kind = card.querySelector(".pc-kind") as HTMLElement | null;
      const badge = card.querySelector(".pbadge")?.getBoundingClientRect();
      const bar = card.querySelector(".pbar")?.getBoundingClientRect();
      const inside = (el: Element | null) => {
        if (!el) return true;
        const b = el.getBoundingClientRect();
        return b.left >= r.left - 0.5 && b.right <= r.right + 0.5;
      };
      return {
        text: name?.textContent ?? "",
        nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || "20")) : 0,
        nameFits: name ? name.scrollWidth <= name.clientWidth + 1 && inside(name) : true,
        kindInside: inside(kind),
        badgeTop: badge ? Math.round(badge.top) : null,
        barTop: bar ? Math.round(bar.top) : null,
      };
    }),
  );
  for (const c of m) {
    expect(c.nameFits, `${c.text}: name fits its card`).toBe(true);
    expect(c.kindInside, `${c.text}: kind stays inside its card`).toBe(true);
  }
  const tops = m.filter((c) => c.badgeTop !== null);
  expect(new Set(tops.map((c) => c.badgeTop)).size, "badges on one row").toBe(1);
  expect(new Set(tops.map((c) => c.barTop)).size, "progress bars on one row").toBe(1);
  return m;
}

for (const width of [1366, 1000]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("PROD and PROD-DR cards: names fit, labels stay inside, rows aligned", async ({ page }) => {
      await page.goto("/?mode=fixtures#/runs/fixtures/enterprise/990008002");
      const cards = await checkCards(page);
      expect(cards.map((c) => c.text)).toContain("prod-dr");
    });

    test("five declared phases with long names", async ({ page }) => {
      await page.goto("/?mode=fixtures#/runs/fixtures/enterprise/990006002");
      await checkCards(page);
    });
  });
}

test("the kind does not repeat the phase name (in any letter case)", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/enterprise/990008002");
  await expect(page.getByTestId("phase-env:prod-dr").locator(".pc-kind")).toHaveText("deploy");
  await page.goto("/?mode=fixtures#/runs/fixtures/enterprise/990006002");
  await expect(page.getByTestId("phase-stage").locator(".pc-kind")).toHaveText("deploy");
});
