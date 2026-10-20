// Captures the release experience at a normal desktop viewport (1366×900) for human review.
// Screenshots go to review-screenshots/ (git-ignored). They are evidence, not pixel-diff assertions.
import { expect, test } from "@playwright/test";

const OUT = "review-screenshots";
const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

test.use({ viewport: { width: 1366, height: 900 } });

test("capture review screenshots", async ({ page }) => {
  await page.goto("/?mode=fixtures");
  await expect(page.getByTestId("demo-gallery")).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-demo-gallery.png` });

  await page.goto(run(990006002));
  await expect(page.getByTestId("phase-rail")).toBeVisible();
  await page.screenshot({ path: `${OUT}/02-release-overview-large-platform.png` });

  await page.goto(run(990003001, "/phases/ci/calls/ci"));
  await expect(page.getByTestId("called-workflow").getByTestId("graph-node").first()).toBeVisible();
  await page.getByTestId("phase-detail").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/03-reusable-ci-expanded.png` });

  await page.goto(run(990004001, "/phases/stage"));
  await expect(page.getByTestId("phase-detail").getByTestId("graph-node").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/04-multi-env-cd-pending-gate.png`, fullPage: true });

  await page.goto(run(990005001, "/phases/stage"));
  await expect(page.getByTestId("phase-detail").getByTestId("graph-node").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/05-failed-deployment-recovery-path.png`, fullPage: true });

  await page.getByRole("button", { name: "Show the failed job" }).click();
  await page.getByTestId("open-log").click();
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await page.getByTestId("job-details").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/06-failed-job-steps-and-log.png` });
});
