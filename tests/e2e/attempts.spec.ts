// Run attempts and workflow-adaptive graphs (fixture mode): a real two-attempt run from the pinned corpus, SYNTHETIC
// multi-attempt runs, and a SYNTHETIC deployment-only run whose workflow declares a CI call GitHub did not report.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const enterprise = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;
const attempt = (page: Page, n: number) => page.locator(`[data-testid=attempt][data-attempt="${n}"]`);
/** Every request the page makes: the app must stay read-only (GET/HEAD) and local in fixture mode. */
function recordRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
  return seen;
}

test("a run with one attempt keeps a clean header: no attempt picker, no banner", async ({ page }) => {
  await page.goto(enterprise(990002001));
  await expect(page.getByTestId("run-stats")).toBeVisible();
  await expect(page.getByTestId("attempts")).toHaveCount(0);
  await expect(page.getByTestId("attempt-banner")).toHaveCount(0);
});

test("real two-attempt run: the failed first attempt and the successful re-run, each with its own job and log", async ({ page }) => {
  const github = await forbidGitHub(page);
  const requests = recordRequests(page);
  await page.goto("/?mode=fixtures#/runs/GauJosh/gha-ui-fixtures/39365979905?view=graph");
  await expect(attempt(page, 2)).toHaveAttribute("aria-current", "true");
  await expect(attempt(page, 2)).toContainText("latest");
  await expect(attempt(page, 1)).toHaveAttribute("data-status", "failure");
  await expect(attempt(page, 2)).toHaveAttribute("data-status", "success");
  await expect(page.getByTestId("attempt-banner")).toHaveCount(0);
  await expect(page.locator("[data-testid=graph-node]")).toHaveAttribute("data-status", "success");

  await attempt(page, 1).click();
  await expect(page).toHaveURL(/#\/runs\/GauJosh\/gha-ui-fixtures\/39365979905\?view=graph&attempt=1$/);
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 2");
  await expect(page.locator("[data-testid=graph-node]")).toHaveAttribute("data-status", "failure");
  await page.locator("[data-testid=graph-node] button").first().click();
  await expect(page).toHaveURL(/\/jobs\/118442808543\?view=graph&attempt=1$/);
  await page.getByTestId("job-details").getByTestId("open-log").click();
  await expect(page).toHaveURL(/\/jobs\/118442808543\/log\?view=graph&attempt=1$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Open on GitHub" }).first()).toHaveAttribute("href", "https://github.com/GauJosh/gha-ui-fixtures/actions/runs/39365979905/attempts/1");

  // Back to the latest attempt: the selection and log of attempt 1 are dropped, the view is kept.
  await page.getByRole("button", { name: "Show the latest attempt (2)" }).click();
  await expect(page).toHaveURL(/#\/runs\/GauJosh\/gha-ui-fixtures\/39365979905\?view=graph$/);
  await expect(page.locator("[data-testid=graph-node]")).toHaveAttribute("data-status", "success");
  await expect(page.getByTestId("log-status")).toHaveCount(0);

  expect(github).toEqual([]);
  expect(requests.filter((r) => !/^(GET|HEAD) /.test(r))).toEqual([]);
  expect(requests.some((r) => r.endsWith("/actions/runs/39365979905/attempts/1/jobs"))).toBe(true);
});

test("three attempts: each attempt's graph, overview, timeline, stats and logs come from that attempt only", async ({ page }) => {
  await page.goto(enterprise(990002005));
  await expect(page.getByTestId("attempt")).toHaveCount(3);
  await expect(attempt(page, 1)).toHaveAttribute("data-status", "failure");
  await expect(attempt(page, 2)).toHaveAttribute("data-status", "failure");
  await expect(attempt(page, 3)).toHaveAttribute("data-status", "success");
  await expect(page.getByTestId("phase-test").locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "succeeded");

  // Attempt 2 failed in Test: the release overview says so.
  await attempt(page, 2).click();
  await expect(page).toHaveURL(/990002005\?attempt=2$/);
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 2 of 3");
  await expect(page.getByTestId("phase-test").locator("[data-phase-status]")).not.toHaveAttribute("data-phase-status", "succeeded");
  await expect(page.getByTestId("stat-counts")).toContainText("1 failed");

  // The timeline keeps the attempt; every row is a job of attempt 2 (ids 990002005500..599).
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/\?view=timeline&attempt=2$/);
  const rows = page.locator("[data-testid=timeline-row]");
  await expect(rows.first()).toBeVisible();
  const ids = await rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-job-id"))));
  expect(ids.length).toBeGreaterThan(5);
  expect(ids.every((id) => id >= 990002005500 && id < 990002005600)).toBe(true);
  await expect(page.locator('[data-testid=timeline-row][data-status="failure"]')).toContainText("e2e-test");

  // Attempt 1: smoke-dev failed, and its logs have expired; that is said, and no other attempt's log is shown.
  await attempt(page, 1).click();
  await expect(page).toHaveURL(/\?view=timeline&attempt=1$/);
  const failed = page.locator('[data-testid=timeline-row][data-status="failure"]');
  await expect(failed).toContainText("smoke-dev");
  await failed.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/jobs\/9900020054\d\d\?view=timeline&attempt=1$/);
  await page.getByTestId("job-details").getByTestId("open-log").click();
  await expect(page.getByTestId("log-status")).toContainText("Logs expired");
});

test("failed in every attempt; an attempt whose jobs cannot be loaded says so instead of showing another attempt", async ({ page }) => {
  await page.goto(enterprise(990002006, "?view=graph"));
  await expect(page.getByTestId("attempt")).toHaveCount(3);
  for (const n of [1, 2, 3]) await expect(attempt(page, n)).toHaveAttribute("data-status", "failure");
  await attempt(page, 1).click();
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 3");
  await expect(page.locator(".graph-panel [role=alert]")).toBeVisible();
  await expect(page.locator("[data-testid=graph-node]")).toHaveCount(0);
  await expect(page.getByTestId("run-stats")).toHaveCount(0);
  // Recovery: another attempt loads normally.
  await attempt(page, 2).click();
  await expect(page.locator('[data-testid=graph-node][data-status="failure"]').first()).toBeVisible();
});

test("an attempt that does not exist is reported with the attempts that do", async ({ page }) => {
  await page.goto(enterprise(990002004, "?attempt=7"));
  await expect(page.getByTestId("attempt-error")).toContainText("Attempt 7 of run #4 could not be loaded: the run has 2 attempts.");
  await attempt(page, 1).click();
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 2");
});

test("deployment-only run: no CI node or frame, declared CI listed as context, real dependencies only", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto(enterprise(990009001, "?view=graph"));
  await expect(page.locator("[data-testid=graph-node]")).toHaveCount(8);
  await expect(page.locator('[data-testid=graph-node][data-node-key^="def:ci"]')).toHaveCount(0);
  await expect(page.getByTestId("group-frame").filter({ hasText: /^ci$/ })).toHaveCount(0);
  await expect(page.locator(".gnode", { hasText: "no job in this run" })).toHaveCount(0);
  await expect(page.getByTestId("declared-context")).toContainText("ci");
  await expect(page.getByTestId("graph-evidence")).toContainText("Not drawn: `deploy-blue` needs `ci`");
  const edges = await page.getByTestId("graph-edge").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-from")}->${e.getAttribute("data-to")}`));
  expect(edges.some((e) => e.includes("def:ci"))).toBe(false);
  // The release overview uses this workflow's own environments.
  await page.getByRole("tab", { name: "Release overview" }).click();
  for (const env of ["blue", "canary-eu", "live"]) await expect(page.getByTestId(`phase-env:${env}`)).toBeVisible();
  await expect(page.getByTestId("phase-call:ci")).toHaveCount(0);
  expect(github).toEqual([]);
});
