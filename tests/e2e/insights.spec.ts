// Run insights (SYNTHETIC fixtures): statistics, the execution timeline and the workflow source explorer, with
// navigation into the existing job, step and log views. No real GitHub request is made.
import { expect, test } from "@playwright/test";
import { forbidGitHub } from "./support";

const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;

test("run statistics: duration, counts, slowest and fastest jobs, critical path, deployments; navigation to a job", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto(run(990008002));
  const stats = page.getByTestId("run-stats");
  await expect(stats.getByTestId("stat-counts")).toHaveText("16: 13 succeeded · 1 failed · 2 skipped");
  await expect(stats.getByTestId("stat-duration")).toHaveText(/^\d+m \d\ds$/);
  await expect(stats.getByTestId("stat-job-time")).toContainText("14 timed jobs");
  await expect(stats.getByTestId("stat-critical-path")).toContainText("jobs in the chain");
  await expect(stats.getByTestId("stat-deployments").locator('[data-environment="prod-dr"]')).toContainText("prod-dr · rolled back");
  await expect(stats.getByTestId("stat-deployments").locator('[data-environment="prod"]')).toContainText("prod · succeeded");
  await expect(stats).not.toContainText("success rate");
  // The slowest job opens in the job details.
  const slowest = stats.getByTestId("stat-slowest").getByRole("button").first();
  const name = (await slowest.textContent())!.replace(/\s\d.*$/, "");
  await slowest.click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  await expect(page.getByTestId("job-details").getByRole("heading", { level: 3 })).toHaveText(name);
  expect(github).toEqual([]);
});

test("timeline: grouped rows on one time axis, failed and skipped jobs distinct, dependencies of the selection, into the log", async ({ page }) => {
  await page.goto(run(990008002));
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/\?view=timeline$/);
  const tl = page.getByTestId("timeline");
  await expect(tl.getByTestId("timeline-group")).toHaveText([/^ci · 2 jobs/, /^dev · 4 jobs/, /^prod · 5 jobs/, /^prod-dr · 5 jobs/]);
  await expect(tl.getByTestId("timeline-bar")).toHaveCount(14);
  const failed = tl.locator('[data-testid=timeline-row][data-status="failure"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText("PROD-DR validation");
  await expect(tl.locator('[data-testid=timeline-row][data-timing="skipped"]')).toHaveCount(2);
  // PROD and PROD-DR ran in parallel: their deploy bars overlap in time.
  const bar = async (text: string) => (await tl.getByTestId("timeline-row").filter({ hasText: text }).getByTestId("timeline-bar").boundingBox())!;
  const [prod, dr] = [await bar("cd / PROD / Smoke test"), await bar("cd / PROD-DR / Smoke test")];
  expect(Math.max(prod.x, dr.x)).toBeLessThan(Math.min(prod.x + prod.width, dr.x + dr.width));
  // Selecting a job keeps the timeline, shows its dependencies, and opens its details and log.
  await failed.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/jobs\/\d+\?view=timeline$/);
  await expect(tl.locator(".tl-row.rel-needs")).toContainText("PROD-DR / Smoke test");
  await expect(tl.locator(".tl-row.rel-needed-by")).toContainText("PROD-DR rollback");
  await expect(page.getByTestId("job-details").getByRole("heading", { level: 3 })).toHaveText("cd / PROD-DR validation");
  await page.getByRole("button", { name: "Open log (failure evidence)" }).click();
  await expect(page).toHaveURL(/\/log\?view=timeline$|\/steps\/\d+\?view=timeline$|\/L\d+\?view=timeline$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
});

test("timeline while jobs are still running: open-ended bars, no end time invented, duration labelled so far", async ({ page }) => {
  await page.goto(run(990001003, "?view=timeline"));
  await expect(page.getByTestId("stat-duration")).toContainText("so far");
  const running = page.locator('[data-testid=timeline-row][data-timing="running"]');
  await expect(running.first()).toBeVisible();
  await expect(running.first()).toContainText("running");
  await expect(page.getByTestId("stat-critical-path")).toContainText("unavailable");
});

test("large run: the timeline renders only the rows on screen and stays navigable", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000105?view=timeline");
  const rows = page.getByTestId("timeline-rows");
  await expect(rows).toBeVisible();
  const rendered = await page.getByTestId("timeline-row").count();
  expect(rendered).toBeGreaterThan(10);
  expect(rendered).toBeLessThan(80); // of about 100 jobs plus group rows
  await rows.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.getByTestId("timeline-row").last()).toBeVisible();
});

test("workflow source: nested calls with distinct identities, revisions, inputs, links to what ran", async ({ page }) => {
  await page.goto(run(990007002, "?view=source"));
  const files = page.getByTestId("source-file");
  await expect(files).toHaveText([/^Run workflow app-release\.yml/, /^ci ci-build\.yml/, /^cd cd-deploy\.yml/, /^DEV deploy-environment\.yml/, /^TEST deploy-environment\.yml/, /^STAGE deploy-environment\.yml/, /^PROD deploy-environment\.yml/]);
  await expect(page.getByTestId("source-file-ref")).toContainText(".github/workflows/app-release.yml");
  await expect(page.getByTestId("source-file-ref")).toContainText("(the run's commit)");
  await files.filter({ hasText: /^cd / }).click();
  const detail = page.getByTestId("source-detail");
  await expect(detail.getByTestId("source-file-ref")).toContainText("fixtures/shared-workflows/.github/workflows/cd-deploy.yml");
  await expect(detail.locator('tr[data-job="deploy-dev"] [data-testid=source-inputs]')).toContainText("environment: dev");
  await expect(detail.locator('tr[data-job="deploy-dev"] [data-testid=source-inputs] li[data-kind="literal"]')).toHaveCount(1);
  await files.filter({ hasText: /^DEV / }).click();
  await expect(detail.getByTestId("source-file-ref")).toContainText("deploy-environment.yml");
  await expect(detail.getByTestId("source-file-ref")).toContainText("the calling workflow's commit");
  // Declared vs ran: the deploy failed in this run; the link selects that job.
  await detail.locator('tr[data-job="deploy"]').getByTestId("source-run-link").click();
  await expect(page.getByTestId("job-details").getByRole("heading", { level: 3 })).toHaveText("cd / DEV / Deploy");
  await expect(page).toHaveURL(/\/jobs\/\d+\?view=source$/);
  await expect(detail.locator('tr[data-job="smoke"]')).toContainText("skipped in this run");
});

test("workflow source: files that cannot be read are labelled with the reason", async ({ page }) => {
  await page.goto(run(990007003, "?view=source"));
  await page.getByTestId("source-file").filter({ hasText: /^cd / }).click();
  await expect(page.getByTestId("source-unavailable")).toContainText("did not report which commit");
  await page.goto(run(990007005, "?view=source"));
  await page.getByTestId("source-file").filter({ hasText: /^cd / }).click();
  await expect(page.getByTestId("source-unavailable")).toBeVisible();
});
