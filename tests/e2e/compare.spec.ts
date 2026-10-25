// Run-to-run comparison and log comparison (fixture mode, SYNTHETIC runs only): choosing a baseline, the summary
// and drill-downs, attempts of one run never mixed, expired logs, and navigation from a difference to its source.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
const enterprise = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;
const row = (page: Page, key: string) => page.locator(`[data-testid=compare-job][data-key="${key}"]`);
function recordMethods(page: Page) {
  const methods = new Set<string>();
  page.on("request", (r) => methods.add(r.method()));
  return methods;
}

test("a failed run against the suggested previous success: summary, jobs, commits, workflow file and dependencies", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = recordMethods(page);
  await page.goto(synthetic(990000108));
  await page.getByRole("tab", { name: "Compare" }).click();
  await expect(page.getByTestId("baseline-picker")).toBeVisible();
  await page.getByTestId("use-suggested").click();
  // The baseline is kept as an explicit run and attempt.
  await expect(page).toHaveURL(/\?view=compare&base=990000109\.1$/);
  await expect(page.getByTestId("side-base")).toHaveAttribute("data-attempt", "1");
  await expect(page.getByTestId("side-head")).toHaveAttribute("data-run", "990000108");

  const summary = page.getByTestId("compare-summary");
  await expect(summary).toContainText("This run failed; the baseline succeeded.");
  await expect(summary).toContainText("2 jobs now fail");
  await expect(summary).toContainText("not a proven cause");

  // Matched by workflow job id: the renamed job is one row, not a removal plus an addition.
  await expect(row(page, "wf:integration")).toContainText("renamed from integration-tests");
  await expect(row(page, "wf:integration")).toHaveAttribute("data-change", "outcome");
  await expect(row(page, "wf:unit#shard 3")).toHaveAttribute("data-change", "added");
  await expect(row(page, "wf:smoke")).toHaveAttribute("data-change", "removed");
  await expect(row(page, "wf:unit#shard 1").getByTestId("compare-duration")).toHaveClass(/trend-slower/);
  // A job that timed out is not reported as slower.
  await expect(row(page, "wf:integration").getByTestId("compare-duration")).not.toHaveClass(/trend-slower/);

  await expect(page.getByTestId("compare-commits")).toContainText("2 commits from the baseline's commit to this run's.");
  await expect(page.getByTestId("compare-commits")).toContainText("not evidence that it caused");
  await expect(page.getByTestId("workflow-diff")).toContainText("name: integration-tests");
  await expect(page.getByTestId("compare-graph")).toContainText("smoke");

  // From a difference to the failed step's log in this run.
  await row(page, "wf:unit#shard 2").locator("xpath=following-sibling::tr[1]").getByRole("link", { name: "this run's log at the step" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+\/steps\/3\?view=compare&base=990000109\.1$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("log comparison: new error lines and their stack trace, linked to the source log", async ({ page }) => {
  await page.goto(synthetic(990000108, "?view=compare&base=990000109.1"));
  await row(page, "wf:unit#shard 2").getByTestId("compare-logs").click();
  const panel = page.getByTestId("log-compare");
  await expect(panel.getByTestId("logcmp-summary")).toContainText("Error lines: 5 new, 0 no longer present.");
  const diff = panel.getByTestId("logcmp-diff");
  await expect(diff.locator('[data-kind="add"]').filter({ hasText: "AssertionError [ERR_ASSERTION]" })).toHaveCount(1);
  await expect(diff.locator('[data-kind="add"]').filter({ hasText: "at Context.<anonymous>" })).toHaveCount(1);
  await expect(diff.locator('[data-kind="remove"]').filter({ hasText: "24 passing" })).toHaveCount(1);
  // Timestamps differ on every line but are not reported as differences.
  await expect(diff.locator('[data-kind="equal"]').filter({ hasText: "running 24 tests in shard 2" })).toHaveCount(1);

  // Step by step: the failed step on its own.
  await panel.getByTestId("logcmp-step").selectOption("Run tests");
  await expect(panel.getByTestId("logcmp-summary")).toContainText("Error lines: 5 new");
  await panel.getByTestId("logcmp-only-errors").check();
  await expect(diff.locator('[data-kind="add"]').first()).toBeVisible();

  // The line number opens this run's log at that line.
  await diff.locator('[data-kind="add"]').filter({ hasText: "AssertionError" }).locator("a").click();
  await expect(page).toHaveURL(/\/jobs\/\d+\/L10\?view=compare&base=990000109\.1/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
});

test("attempts of one run: compared side by side, each from its own jobs", async ({ page }) => {
  await page.goto(enterprise(990002004, "?view=compare"));
  await page.locator('[data-testid=pick-attempt][data-attempt="1"]').click();
  await expect(page).toHaveURL(/\?view=compare&base=990002004\.1$/);
  await expect(page.getByTestId("side-base")).toHaveAttribute("data-attempt", "1");
  await expect(page.getByTestId("side-head")).toHaveAttribute("data-attempt", "2");
  await expect(page.getByTestId("compare-summary")).toContainText("This run succeeded; the baseline failed.");
  await expect(page.getByTestId("compare-commits")).toContainText("Both ran commit");
  // Every baseline link points at attempt 1's own jobs (ids of earlier attempts start at runId*1000+400).
  const links = page.locator("[data-testid=compare-job]").getByRole("link", { name: "baseline job" });
  await expect(links.first()).toBeVisible();
  for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) {
    expect(href).toMatch(/\?view=graph&attempt=1$/);
    const id = Number(/\/jobs\/(\d+)/.exec(href)![1]);
    expect(id).toBeGreaterThanOrEqual(990002004 * 1000 + 400);
    expect(id).toBeLessThan(990002004 * 1000 + 500);
  }
});

test("a baseline attempt that GitHub reports with another attempt number is refused, not shown as the requested one", async ({ page }) => {
  // Run 990000110's attempt 1 endpoint answers with run_attempt 2 (a deliberately inconsistent synthetic response).
  const requested: string[] = [];
  page.on("request", (r) => requested.push(new URL(r.url()).pathname));
  await page.goto(synthetic(990000110, "?view=compare&base=990000110.1"));
  const base = page.getByTestId("side-base");
  await expect(base).toContainText("Could not be loaded.");
  await expect(page.getByRole("alert")).toContainText(
    "GitHub returned attempt 2 when attempt 1 was requested, so it is not shown as attempt 1. Try again, or choose another attempt.",
  );
  await expect(page.getByRole("alert").getByRole("button", { name: "Try again" })).toBeVisible();
  // The baseline is not shown as attempt 1 (nor as attempt 2), and nothing is compared.
  await expect(base).not.toHaveAttribute("data-attempt", /.+/);
  await expect(page.getByTestId("side-head")).toHaveAttribute("data-attempt", "2");
  await expect(page.getByTestId("compare-summary")).toHaveCount(0);
  await expect(page.getByTestId("compare-jobs")).toHaveCount(0);
  // The explicit attempt was what the baseline requested.
  expect(requested.some((p) => p.endsWith("/actions/runs/990000110/attempts/1"))).toBe(true);
});

test("log comparison with failing log workers: one failure recovers to the real result, repeated failures end in an error, never a false result", async ({ page }) => {
  // `fixture-faults=worker-failures-N`: each log's first N workers fail halfway through the body. The 46 MB log
  // arrives in many chunks, so the failure lands mid-download (both sides are that one log, as in the test below).
  const open = async (faults: string) => {
    await page.goto(`/?mode=fixtures&fixture-faults=${faults}#/runs/fixtures/synthetic/990000001?view=compare&base=990000001.1`);
    await page.getByTestId("show-all-jobs").check();
    await page.getByTestId("compare-logs").first().click();
    const panel = page.getByTestId("log-compare");
    await panel.getByTestId("logcmp-side-status").first().getByRole("button", { name: "Load the full log" }).click({ timeout: 30_000 });
    return panel;
  };
  // One failure: the log reloads from the start and the comparison gives the same result as without faults.
  let panel = await open("worker-failures-1");
  await expect(panel.getByTestId("logcmp-side-status")).toHaveCount(0, { timeout: 90_000 });
  await expect(panel.getByTestId("logcmp-summary")).toHaveText(/^No differences in the (\d+) and \1 lines compared\.$/, { timeout: 60_000 });

  // Repeated failures: the log stops in an error state; nothing is compared or claimed.
  panel = await open("worker-failures-3");
  const status = panel.getByTestId("logcmp-side-status");
  await expect(status.first()).toContainText("Log processing stopped after repeated internal errors.", { timeout: 90_000 });
  await expect(status.first()).toHaveClass(/state-error/);
  await expect(panel.getByTestId("logcmp-summary")).toHaveCount(0);
  await expect(panel.getByTestId("logcmp-diff")).toHaveCount(0);
  await expect(panel.getByText("Comparing…")).toHaveCount(0);
  await expect(panel.getByText(/No differences/)).toHaveCount(0);
});

test("closing a log comparison while a full log is loading terminates its worker and leaves no stale result", async ({ page }) => {
  // Every web worker the page starts, and whether it has been terminated (Playwright reports both).
  let started = 0;
  let closed = 0;
  page.on("worker", (w) => {
    started++;
    w.once("close", () => closed++);
  });
  await page.goto(synthetic(990000001, "?view=compare&base=990000001.1"));
  await page.getByTestId("show-all-jobs").check();
  await page.getByTestId("compare-logs").first().click();
  const panel = page.getByTestId("log-compare");
  const load = panel.getByTestId("logcmp-side-status").first().getByRole("button", { name: "Load the full log" });
  await expect(load).toBeVisible({ timeout: 30_000 });
  expect(started - closed).toBeGreaterThan(0);

  // Hold the full-log request, so the panel is certainly closed mid-load.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held: import("@playwright/test").Request | undefined;
  let handled!: () => void;
  const released = new Promise<void>((resolve) => (handled = resolve));
  await page.route("**/actions/jobs/990000002/logs", async (route) => {
    held = route.request();
    await gate;
    await route.continue().catch(() => {}); // the app may already have aborted it
    handled();
  });
  await load.click();
  await expect.poll(() => held !== undefined).toBe(true);
  await expect(panel.getByTestId("logcmp-side-status").first()).toContainText("Loading full log");

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  // The pool was disposed: every worker the comparison started has been terminated.
  await expect.poll(() => started - closed, { timeout: 10_000 }).toBe(0);

  // Let the held request go (the app has aborted it): nothing from the closed comparison comes back.
  release();
  await released;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.getByTestId("log-compare")).toHaveCount(0);
  await expect(page.getByTestId("logcmp-summary")).toHaveCount(0);
  await expect(page.getByTestId("logcmp-side-status")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(started - closed).toBe(0);
});

test("a log worker that fails after its log completed: the comparison reports it cannot read the log, never a result", async ({ page }) => {
  // A small log arrives in one chunk, so the injected failure lands after the download finished.
  await page.goto(`/?mode=fixtures&fixture-faults=worker-failures-1#/runs/fixtures/synthetic/990000108?view=compare&base=990000109.1`);
  await row(page, "wf:unit#shard 2").getByTestId("compare-logs").click();
  const panel = page.getByTestId("log-compare");
  await expect(panel.getByText(/log could not be read for comparison\./)).toHaveClass(/state-error/, { timeout: 60_000 });
  await expect(panel.getByTestId("logcmp-summary")).toHaveCount(0);
  await expect(panel.getByTestId("logcmp-diff")).toHaveCount(0);
});

test("a job with no log in this run: the log is reported unavailable and nothing is presented as a difference", async ({ page }) => {
  // In 990000108 `package` was skipped (no log); in the baseline 990000109 it ran.
  await page.goto(synthetic(990000108, "?view=compare&base=990000109.1"));
  await row(page, "wf:package").getByTestId("compare-logs").click();
  const panel = page.getByTestId("log-compare");
  const status = panel.getByTestId("logcmp-side-status");
  await expect(status).toHaveCount(1);
  await expect(status).toContainText("This run's log:");
  await expect(status).toHaveClass(/state-error/);
  await expect(panel.getByTestId("logcmp-summary")).toHaveCount(0);
  await expect(panel.getByTestId("logcmp-diff")).toHaveCount(0);
  await expect(panel.getByText("Comparing…")).toHaveCount(0);
});

test("a log above the automatic-load limit is not compared from its tail: the full log loads only on request", async ({ page }) => {
  // The large synthetic log against itself (the same execution, flagged as such): both sides are the 46 MB log.
  await page.goto(synthetic(990000001, "?view=compare&base=990000001.1"));
  await expect(page.getByTestId("not-comparable")).toContainText("same attempt of the same run");
  await page.getByTestId("show-all-jobs").check();
  await page.getByTestId("compare-logs").first().click();
  const panel = page.getByTestId("log-compare");
  const status = panel.getByTestId("logcmp-side-status");
  await expect(status.first()).toContainText("above the 44.0 MB automatic-load limit", { timeout: 30_000 });
  await expect(status.first()).toContainText("Only complete logs are compared.");
  await expect(status.first().getByRole("button", { name: "Load the full log" })).toBeVisible();
  await expect(status.first()).not.toHaveClass(/state-error/);
  await expect(panel.getByTestId("logcmp-summary")).toHaveCount(0);
  await expect(panel.getByTestId("logcmp-diff")).toHaveCount(0);

  // Loading the full log (one log, one worker: both sides are the same job) lets the comparison run.
  await status.first().getByRole("button", { name: "Load the full log" }).click();
  // A side's status line is shown until its log is complete.
  await expect(status).toHaveCount(0, { timeout: 90_000 });
  const summary = panel.getByTestId("logcmp-summary");
  await expect(summary).toBeVisible({ timeout: 60_000 });
  const m = /^No differences in the (\d+) and (\d+) lines compared\.$/.exec((await summary.textContent())!.trim());
  expect(m, "an identical log compares as having no differences").not.toBeNull();
  expect(m![1]).toBe(m![2]);
  // Essential output leaves out runner markers only: nearly all 460,000 lines are compared.
  expect(Number(m![1])).toBeGreaterThan(459_000);
  expect(Number(m![1])).toBeLessThanOrEqual(460_000);
  await expect(panel.getByTestId("logcmp-diff")).toHaveCount(0);
});

test("an expired baseline log is reported, not compared", async ({ page }) => {
  await page.goto(enterprise(990002005, "?view=compare&base=990002005.1"));
  await page.locator("[data-testid=compare-job][data-change=outcome]").first().getByTestId("compare-logs").click();
  await expect(page.getByTestId("log-compare").getByTestId("logcmp-side-status").first()).toContainText(/expired/i);
  await expect(page.getByTestId("logcmp-summary")).toHaveCount(0);
});

test("the same execution on both sides is flagged as not comparable", async ({ page }) => {
  await page.goto(synthetic(990000108, "?view=compare&base=990000108.1"));
  await expect(page.getByTestId("not-comparable")).toContainText("same attempt of the same run");
});
