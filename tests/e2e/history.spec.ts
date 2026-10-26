// Run history (fixture mode, SYNTHETIC runs only): what was loaded, durations with conclusions, a baseline that
// says when there is not enough history, slowest jobs, and GET-only requests.
import { expect, test } from "@playwright/test";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;

test("history of a workflow with too little data: loaded runs are counted, durations shown, no baseline claimed", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = new Set<string>();
  const jobsRequests: string[] = [];
  page.on("request", (r) => {
    methods.add(r.method());
    if (/\/actions\/runs\/\d+\/(attempts\/\d+\/)?jobs/.test(r.url())) jobsRequests.push(new URL(r.url()).pathname);
  });
  // 990000109 (success) and 990000108 (a later failure) are the two runs of this workflow.
  await page.goto(synthetic(990000109));
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page).toHaveURL(/\?view=history$/);
  const history = page.getByTestId("run-history");
  await expect(history.getByTestId("history-count")).toContainText("1 earlier run loaded (of 2 listed for this workflow; at most 20)");
  const points = history.getByTestId("history-point");
  await expect(points).toHaveCount(2);
  await expect(points.nth(0)).toHaveAttribute("data-run", "990000109");
  await expect(points.nth(0)).toContainText("this run");
  await expect(points.nth(1)).toHaveAttribute("data-run", "990000108");
  await expect(points.nth(1).locator("[data-status]")).toHaveAttribute("data-status", "failure");
  await expect(points.nth(1).getByRole("link")).toHaveAttribute("href", /#\/runs\/fixtures\/synthetic\/990000108\?view=graph&attempt=1$/);
  // The only other run is later than this one: there are no earlier successful runs to compare with.
  const baseline = history.getByTestId("history-baseline");
  await expect(baseline).toHaveAttribute("data-kind", "insufficient");
  await expect(baseline).toContainText("Not enough history for a baseline: 0 earlier successful runs");
  await expect(history.getByTestId("history-job")).not.toHaveCount(0);
  // The overview says what is missing instead of showing a figure.
  await expect(history.getByTestId("kpi-median")).toContainText("Not available");
  await expect(history.getByTestId("kpi-median")).toContainText("0 of 5 earlier successful runs needed");
  await expect(history.getByTestId("kpi-change")).toHaveCount(0);
  await expect(history.getByTestId("kpi-duration")).toContainText("No baseline to compare with");
  await expect(history.getByTestId("kpi-outcomes")).toContainText("0 of 1");
  await expect(history.getByTestId("kpi-outcomes")).toContainText("1 failed");
  await expect(history.getByTestId("history-chart-median")).toHaveCount(0);
  await expect(history.getByTestId("history-chart-point")).toHaveCount(2);
  // The earlier run's jobs come from its own attempt endpoint.
  expect(jobsRequests).toContain("/__fixtures/api/repos/fixtures/synthetic/actions/runs/990000108/attempts/1/jobs");
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("history with enough earlier successful runs: measured baseline, slowest jobs, links at each run's attempt", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = new Set<string>();
  const jobsRequests: string[] = [];
  page.on("request", (r) => {
    methods.add(r.method());
    if (/\/actions\/runs\/\d+\/(attempts\/\d+\/)?jobs/.test(r.url())) jobsRequests.push(new URL(r.url()).pathname);
  });
  // "[synthetic] Nightly build": 990000127 is the latest of eight runs; the seven earlier ones are six successes
  // (990000124 on attempt 2) and one failure (990000122). Each run lasts build + 2s + test.
  await page.goto(synthetic(990000127, "?view=history"));
  const history = page.getByTestId("run-history");
  await expect(history.getByTestId("history-count")).toContainText("7 earlier runs loaded (of 8 listed for this workflow; at most 20)");
  await expect(history.getByTestId("history-failed")).toHaveCount(0);

  // Earlier successful durations 162, 172, 182, 192, 202, 232s: median 187s; this run 262s.
  const baseline = history.getByTestId("history-baseline");
  await expect(baseline).toHaveAttribute("data-kind", "measured");
  await expect(baseline).toContainText("This run took 4m 22s; the median of 6 earlier successful runs is 3m 07s (range 2m 42s–3m 52s).");
  await expect(baseline).toContainText("Difference: +1m 15s (140% of the median). 6 earlier runs were faster, 0 slower.");
  await expect(baseline).not.toContainText("other branches");

  const points = history.getByTestId("history-point");
  await expect(points).toHaveCount(8);
  await expect(points.nth(0)).toHaveAttribute("data-run", "990000120");
  await expect(points.nth(7)).toHaveAttribute("data-run", "990000127");
  await expect(points.nth(7)).toContainText("this run");
  await expect(points.nth(2).locator("[data-status]")).toHaveAttribute("data-status", "failure");
  const retried = history.locator('[data-testid="history-point"][data-run="990000124"]');
  await expect(retried).toHaveAttribute("data-attempt", "2");
  await expect(retried).toContainText("attempt 2");
  await expect(retried.getByRole("link")).toHaveAttribute("href", /#\/runs\/fixtures\/synthetic\/990000124\?view=graph&attempt=2$/);
  await expect(points.nth(0).getByRole("link")).toHaveAttribute("href", /#\/runs\/fixtures\/synthetic\/990000120\?view=graph&attempt=1$/);
  await expect(history.getByTestId("history-unmeasured")).toHaveCount(0);

  // Overview figures, from the same model.
  await expect(history.getByTestId("kpi-duration")).toContainText("4m 22s");
  await expect(history.getByTestId("kpi-duration")).toContainText("Baseline median 3m 07s");
  await expect(history.getByTestId("kpi-median")).toContainText("3m 07s");
  await expect(history.getByTestId("kpi-median")).toContainText("6 earlier successful runs, 2m 42s–3m 52s");
  const change = history.getByTestId("kpi-change");
  await expect(change).toHaveAttribute("data-direction", "slower");
  await expect(change).toContainText("1m 15s slower");
  await expect(change).toContainText("140% of the median; 6 of 6 earlier runs were faster");
  await expect(history.getByTestId("kpi-outcomes")).toContainText("6 of 7");
  await expect(history.getByTestId("kpi-outcomes")).toContainText("1 failed");
  await expect(history.getByTestId("kpi-outcomes")).not.toContainText("cancelled");

  // The chart: oldest first, outcomes kept, the median line drawn, details on hover, links at each run's attempt.
  const chart = history.getByTestId("history-chart");
  const cols = chart.getByTestId("history-chart-point");
  await expect(cols).toHaveCount(8);
  expect(await cols.evaluateAll((els) => els.map((e) => e.getAttribute("data-run")))).toEqual(["990000120", "990000121", "990000122", "990000123", "990000124", "990000125", "990000126", "990000127"]);
  await expect(cols.nth(2)).toHaveAttribute("data-outcome", "failed");
  await expect(cols.nth(4)).toHaveAttribute("data-attempt", "2");
  await expect(chart.getByTestId("history-chart-median")).toBeVisible();
  await expect(chart.getByTestId("history-chart-median-label")).toHaveText("median 3m 07s");
  await expect(chart.getByTestId("history-chart-detail")).toHaveText("This run: succeeded, 4m 22s");
  await cols.nth(4).getByRole("link").hover();
  await expect(chart.getByTestId("history-chart-detail")).toHaveText("Run #124, attempt 2: succeeded, 3m 52s");
  await expect(cols.nth(4).getByRole("link")).toHaveAttribute("aria-label", "Run #124, attempt 2: succeeded, 3m 52s");
  await expect(cols.nth(4).getByRole("link")).toHaveAttribute("href", /#\/runs\/fixtures\/synthetic\/990000124\?view=graph&attempt=2$/);
  await expect(cols.nth(7).getByRole("link")).toHaveCount(0);

  // Slowest first by median over the runs where the job succeeded (this run included).
  const jobs = history.getByTestId("history-job");
  await expect(jobs).toHaveCount(3);
  await expect(jobs.nth(0)).toHaveAttribute("data-key", "name:test");
  await expect(jobs.nth(0)).toContainText("2m 05s");
  await expect(jobs.nth(0)).toContainText("1m 50s–2m 50s");
  await expect(jobs.nth(0)).toContainText("7 succeeded, 1 stopped early");
  await expect(jobs.nth(1)).toHaveAttribute("data-key", "name:build");
  await expect(jobs.nth(1)).toContainText("1m 03s");
  await expect(jobs.nth(1)).toContainText("50s–1m 30s");
  await expect(jobs.nth(1)).toContainText("8 succeeded");
  await expect(jobs.nth(2)).toHaveAttribute("data-key", "name:lint");
  await expect(jobs.nth(2)).toContainText("8 succeeded");

  // Following a chart column opens that run at the attempt it was measured at.
  await cols.nth(4).getByRole("link").click();
  await expect(page).toHaveURL(/990000124\?view=graph&attempt=2$/);

  // Every earlier run's jobs came from its own attempt endpoint, never the latest-jobs list.
  for (const id of [990000120, 990000121, 990000122, 990000123, 990000125, 990000126]) {
    expect(jobsRequests).toContain(`/__fixtures/api/repos/fixtures/synthetic/actions/runs/${id}/attempts/1/jobs`);
  }
  expect(jobsRequests).toContain("/__fixtures/api/repos/fixtures/synthetic/actions/runs/990000124/attempts/2/jobs");
  expect(jobsRequests.filter((p) => /\/runs\/9900001(2[0-6])\/jobs$/.test(p))).toEqual([]);
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("history edge cases: in-progress, cancelled and untimed runs are labelled, never drawn as zero, and stay reachable", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = new Set<string>();
  page.on("request", (r) => methods.add(r.method()));
  // "[synthetic] Edge history": 990000130 succeeded (1m 30s), 990000131 was cancelled after 1m 30s, 990000132's job
  // has no start time, 990000133's job ends before it starts, and 990000134 (this run) is still in progress.
  await page.goto(synthetic(990000134, "?view=history"));
  const history = page.getByTestId("run-history");
  await expect(history.getByTestId("history-count")).toContainText("4 earlier runs loaded (of 5 listed for this workflow; at most 20)");

  // No figure is made up for this run or a baseline.
  await expect(history.getByTestId("kpi-duration")).toContainText("Not measured");
  await expect(history.getByTestId("kpi-duration")).toContainText("Its duration is unavailable (in progress).");
  await expect(history.getByTestId("kpi-median")).toContainText("Not available");
  await expect(history.getByTestId("kpi-median")).toContainText("This run has no measurable duration (in progress).");
  await expect(history.getByTestId("kpi-change")).toHaveCount(0);
  await expect(history.getByTestId("kpi-outcomes")).toContainText("3 of 4");
  await expect(history.getByTestId("kpi-outcomes")).toContainText("1 cancelled");
  await expect(history.getByTestId("history-baseline")).toHaveAttribute("data-kind", "not-comparable");

  const chart = history.getByTestId("history-chart");
  await expect(chart).toContainText("2 runs measured, 3 not measured (shown as an empty slot)");
  const cols = chart.getByTestId("history-chart-point");
  await expect(cols).toHaveCount(5);
  const col = (id: number) => chart.locator(`[data-testid="history-chart-point"][data-run="${id}"]`);
  const expected: [number, string, string, string][] = [
    [990000130, "succeeded", "true", "Run #130: succeeded, 1m 30s"],
    [990000131, "cancelled", "true", "Run #131: cancelled, 1m 30s"],
    [990000132, "succeeded", "false", "Run #132: succeeded, not measured (missing timestamps)"],
    [990000133, "succeeded", "false", "Run #133: succeeded, not measured (invalid timestamps)"],
  ];
  for (const [id, outcome, measured, label] of expected) {
    await expect(col(id)).toHaveAttribute("data-outcome", outcome);
    await expect(col(id)).toHaveAttribute("data-measured", measured);
    const link = col(id).getByRole("link");
    await expect(link).toHaveAttribute("aria-label", label);
    await expect(link).toHaveAttribute("href", new RegExp(`#/runs/fixtures/synthetic/${id}\\?view=graph&attempt=1$`));
    // An unmeasured run has an empty slot and no bar; a measured one has a bar.
    await expect(col(id).locator(".history-col-bar")).toHaveCount(measured === "true" ? 1 : 0);
    await expect(col(id).locator(".history-col-empty")).toHaveCount(measured === "true" ? 0 : 1);
  }
  // The cancelled run is outlined, not filled like a success.
  await expect(col(990000131).locator(".history-col-bar")).toHaveClass(/outcome-cancelled/);
  const fill = await col(990000131).locator(".history-col-bar").evaluate((e) => getComputedStyle(e).backgroundColor);
  const successFill = await col(990000130).locator(".history-col-bar").evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(fill).not.toBe(successFill);
  // This run: in progress, an empty slot, not a link.
  await expect(col(990000134)).toHaveAttribute("data-outcome", "in progress");
  await expect(col(990000134)).toHaveAttribute("data-measured", "false");
  await expect(col(990000134).getByRole("link")).toHaveCount(0);
  await expect(chart.getByTestId("history-chart-detail")).toHaveText("This run: in progress, not measured (in progress)");
  await expect(chart.getByTestId("history-chart-median")).toHaveCount(0);
  const legend = chart.getByRole("list", { name: "Legend" });
  await expect(legend).toContainText("succeeded");
  await expect(legend).toContainText("cancelled");
  await expect(legend).toContainText("not measured");

  // The run table says the same, with the reason instead of a duration.
  const points = history.getByTestId("history-point");
  await expect(points.filter({ hasText: "#132" })).toContainText("not measured: missing timestamps");
  await expect(points.filter({ hasText: "#133" })).toContainText("not measured: invalid timestamps");
  await expect(points.filter({ hasText: "this run" })).toContainText("not measured: in progress");
  await expect(history.getByTestId("history-unmeasured")).toContainText("3 runs have no measurable duration");

  // Unmeasured runs stay reachable at their attempt.
  await col(990000132).getByRole("link").focus();
  await expect(chart.getByTestId("history-chart-detail")).toHaveText("Run #132: succeeded, not measured (missing timestamps)");
  await col(990000132).getByRole("link").click();
  await expect(page).toHaveURL(/990000132\?view=graph&attempt=1$/);
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("history: when this run's jobs cannot be loaded, the error and Try again are shown, not an endless loading state", async ({ page }) => {
  let fail = true;
  await page.route(/\/actions\/runs\/990000127\/(attempts\/\d+\/)?jobs/, (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"synthetic failure"}' }) : route.fallback()));
  await page.goto(synthetic(990000127, "?view=history"));
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Loading this run…")).toHaveCount(0);
  fail = false;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("history-count")).toContainText("7 earlier runs loaded");
});
