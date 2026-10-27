// Retries and recurrence (fixture mode, SYNTHETIC runs only): loaded on request, every attempt of the run through the
// attempt loader, history only when asked, GET only, no logs or artifacts, and evidence that never outlives its run.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
const API = "/__fixtures/api/repos/fixtures/synthetic";

/** Every fixture API request (path and query), with its method. */
function record(page: Page) {
  const requests: { method: string; path: string }[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/__fixtures/api/")) requests.push({ method: r.method(), path: u.pathname + u.search });
  });
  return requests;
}
const section = (page: Page) => page.getByTestId("run-retries");
const findings = (page: Page, testId: "retry-finding" | "recurrence-finding") =>
  section(page)
    .getByTestId(testId)
    .evaluateAll((els) => els.map((e) => `${e.getAttribute("data-job")}: ${e.getAttribute("data-kind")}`));

test("retries: nothing loaded until asked; every attempt read, one unreadable; findings and coverage; GET only", async ({ page }) => {
  const github = await forbidGitHub(page);
  const requests = record(page);
  // 990000142 is at attempt 3: attempt 1 failed integration, e2e and one "check"; attempt 2's jobs answer 500;
  // attempt 3 re-ran the failed jobs and lists build as run in attempt 1.
  await page.goto(synthetic(990000142));
  await expect(section(page).getByTestId("retries-state")).toHaveAttribute("data-state", "not loaded");
  await expect(page.getByTestId("attempt-row").or(page.getByText("Attempt 3")).first()).toBeVisible();
  await page.waitForTimeout(400);
  const before = requests.length;
  expect(requests.filter((r) => /\/attempts\/\d+\/jobs|\/workflows\/9912\/runs/.test(r.path))).toEqual([]);

  await section(page).getByTestId("load-retries").click();
  const evidence = section(page).getByTestId("retries-evidence");
  await expect(evidence).toHaveAttribute("data-state", "incomplete");
  await expect(evidence).toHaveAttribute("data-run", "990000142");
  await expect(section(page).getByTestId("retries-attempts")).toHaveText(
    "Read 2 of 3 attempts of run 990000142 (attempts 1 and 3). Not read: attempt 2; what happened in it is unknown, not a success.",
  );
  // The section's own requests: each attempt and its jobs, nothing else.
  const own = requests.slice(before);
  expect(new Set(own.filter((r) => /\/attempts\/\d+\/jobs/.test(r.path)).map((r) => r.path))).toEqual(
    new Set([1, 2, 3].map((n) => `${API}/actions/runs/990000142/attempts/${n}/jobs?per_page=100`)),
  );
  expect(own.filter((r) => /\/logs|\/artifacts|\/deployments|\/releases|\/runs\?|\/workflows\/\d+\/runs/.test(r.path))).toEqual([]);

  expect(await findings(page, "retry-finding")).toEqual(["check: insufficient evidence", "e2e: failed in every attempt observed", "integration: recovered on retry"]);
  const recovered = section(page).locator('[data-testid="retry-finding"][data-kind="recovered on retry"]');
  await expect(recovered).toContainText("It failed in attempt 1 (failure, job 99000014252) and succeeded when run again in attempt 3 (job 99000014202).");
  await expect(recovered).toContainText("Not by itself evidence of flakiness or of why it failed.");
  await expect(section(page).locator('[data-kind="failed in every attempt observed"]')).toContainText("(attempts 1 and 3). These are retries of one run, not a recurrence across runs.");
  const check = section(page).locator('[data-testid="retry-finding"][data-job="check"]');
  await expect(check).toContainText("(matched by name only)");
  await expect(check).toContainText("In attempts 1 and 3, more than one job has this identity, so its jobs cannot be told apart between attempts.");
  // build is carried over: one observation, in attempt 1, and no finding.
  await expect(section(page).getByTestId("retries-carried")).toContainText("GitHub lists 1 job in a later attempt as run in an earlier attempt");
  await expect(section(page).getByTestId("retries-carried")).toContainText("has not been verified against live runs");
  await expect(section(page).locator('[data-testid="retry-observation"][data-job-id="99000014251"]')).toHaveAttribute("data-attempt", "1");
  await expect(section(page).locator('[data-testid="retry-finding"][data-job="build"]')).toHaveCount(0);
  await expect(section(page).getByTestId("retries-matching")).toHaveText(
    "Within this run, “check” is matched by name only: weaker evidence than the workflow file's identity, since a renamed or duplicated job cannot be told apart.",
  );
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "not loaded");
  await expect(section(page).getByTestId("retries-across")).toContainText("Not compared: history is not loaded.");
  await expect(section(page).getByTestId("retries-limitations")).toContainText("Attempt 2 was not read (GitHub request failed: http-error).");
  const text = (await section(page).textContent()) ?? "";
  expect(text).not.toMatch(/flaky test|root cause|caused by/i);

  // History, on request: recurrence and mixed outcomes across distinct runs, each at its latest attempt.
  const beforeHistory = requests.length;
  await section(page).getByTestId("load-retry-history").click();
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "loaded");
  expect(await findings(page, "recurrence-finding")).toEqual(["e2e: recurring failure", "integration: mixed outcomes"]);
  await expect(section(page).locator('[data-testid="recurrence-finding"][data-kind="recurring failure"]')).toContainText("failed in 3 of the 3 runs compared (runs 990000140, 990000141 and 990000142; it appears in 3 runs)");
  await expect(section(page).locator('[data-testid="recurrence-finding"][data-kind="mixed outcomes"]')).toContainText(
    "failed in run 990000141 and succeeded in runs 990000140 and 990000142. No commit has both outcomes",
  );
  const history = section(page).getByTestId("retries-history");
  await expect(history).toContainText("Compared with 2 earlier runs of this workflow");
  await expect(history).toContainText("a limited window, not every run. Each earlier run is represented by its latest attempt only");
  await expect(history).toContainText("this run by its latest attempt (3), so its earlier failed attempts do not make it count as failed.");
  await expect(history).toContainText("Across runs, jobs are matched by name only");
  expect(requests.slice(beforeHistory).map((r) => r.path.replace(/\?.*/, ""))).toEqual(
    expect.arrayContaining([`${API}/actions/workflows/9912/runs`, `${API}/actions/runs/990000140/attempts/1/jobs`, `${API}/actions/runs/990000141/attempts/1/jobs`]),
  );
  // This run counts at attempt 3, where integration succeeded.
  await section(page).getByTestId("retries-observations").locator("summary").click();
  await expect(section(page).locator('[data-testid="recurrence-observation"][data-run="990000142"][data-job-id="99000014202"]')).toHaveAttribute("data-outcome", "succeeded");

  expect(requests.every((r) => r.method === "GET" || r.method === "HEAD")).toBe(true);
  expect(requests.filter((r) => /\/logs|\/artifacts/.test(r.path))).toEqual([]);
  expect(github).toEqual([]);
});

test("retries: history loaded with no earlier runs is not the same as history not loaded", async ({ page }) => {
  await forbidGitHub(page);
  // 990000143 failed lint, then passed it on attempt 2; its workflow has no other runs.
  await page.goto(synthetic(990000143));
  await section(page).getByTestId("load-retries").click();
  await expect(section(page).getByTestId("retries-evidence")).toHaveAttribute("data-state", "complete");
  expect(await findings(page, "retry-finding")).toEqual(["lint: recovered on retry"]);
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "not loaded");
  await expect(section(page).getByTestId("retries-history")).toContainText("History not loaded: how these jobs did in other runs of this workflow is unknown.");
  await section(page).getByTestId("load-retry-history").click();
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "loaded, none");
  await expect(section(page).getByTestId("retries-history")).toHaveText("History loaded: there are no earlier runs of this workflow to compare with.");
  await expect(section(page).getByTestId("retries-across-none")).toBeVisible();
  await expect(section(page).getByTestId("retries-limitations")).toContainText("History was loaded and holds no earlier runs of this workflow.");
});

test("retries: loading, an error with Try again (never repeated on its own), empty evidence and a mismatched attempt", async ({ page }) => {
  await forbidGitHub(page);
  const requests = record(page);
  // Loading: the attempts answer slowly.
  await page.route(`**${API}/actions/runs/990000143/attempts/*/jobs*`, async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  // The history listing fails once, then answers.
  let listings = 0;
  await page.route(`**${API}/actions/workflows/9913/runs*`, (route) => (++listings === 1 ? route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"[synthetic] Server Error"}' }) : route.continue()));
  await page.goto(synthetic(990000143));
  await section(page).getByTestId("load-retries").click();
  await expect(section(page).getByTestId("retries-state")).toHaveAttribute("data-state", "loading");
  await expect(section(page).getByTestId("retries-state")).toHaveText("Loading 2 attempts of this run…");
  await expect(section(page).getByTestId("retries-evidence")).toBeVisible();

  await section(page).getByTestId("load-retry-history").click();
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "error");
  await expect(section(page).getByTestId("retries-history").getByRole("alert")).toBeVisible();
  await expect(section(page).getByTestId("retries-history")).toContainText("History unavailable: other runs are unknown, not absent.");
  await page.waitForTimeout(1500);
  expect(listings).toBe(1);
  await section(page).getByTestId("retries-history").getByRole("button", { name: "Try again" }).click();
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "loaded, none");
  expect(listings).toBe(2);

  // Empty: one attempt, nothing failed.
  await page.goto(synthetic(990000127));
  await section(page).getByTestId("load-retries").click();
  await expect(section(page).getByTestId("retries-evidence")).toHaveAttribute("data-findings", "0");
  await expect(section(page).getByTestId("retries-evidence")).toHaveAttribute("data-state", "complete");
  await expect(section(page).getByTestId("retries-within-none")).toBeVisible();
  await expect(section(page).getByTestId("retries-viewed")).toHaveCount(0);

  // GitHub answers attempt 1 of 990000110 with attempt 2: it is not read, and nothing stands in for it.
  await page.goto(synthetic(990000110));
  await section(page).getByTestId("load-retries").click();
  await expect(section(page).getByTestId("retries-evidence")).toHaveAttribute("data-state", "incomplete");
  await expect(section(page).getByTestId("retries-attempts")).toContainText("Read 1 of 2 attempts of run 990000110 (attempt 2).");
  await expect(section(page).getByTestId("retries-limitations")).toContainText("Attempt 1 was not read (GitHub returned attempt 2 when attempt 1 was requested");
  expect(requests.some((r) => r.path.includes("/runs/990000110/attempts/1/jobs"))).toBe(false);
});

// The section passes the run the page already loaded to loadAttempts, so finding the attempt count makes no request
// of its own: a run whose run_attempt is malformed fails before any attempt is read, and "Try again" retries on the
// same run object, so it cannot recover here. Reloading the page's run is not this section's responsibility.
test("retries: a run with a malformed run_attempt shows an error, no evidence, and Try again cannot recover it", async ({ page }) => {
  await forbidGitHub(page);
  const requests = record(page);
  await page.goto(synthetic(990000144));
  await section(page).getByTestId("load-retries").click();
  const state = section(page).getByTestId("retries-state");
  await expect(state).toHaveAttribute("data-state", "error");
  await expect(state.getByRole("alert")).toContainText("GitHub did not report how many attempts the run has.");
  await expect(state).toContainText("The attempts are unavailable, not absent: no partial evidence is shown.");
  const noEvidence = async () => {
    await expect(section(page).getByTestId("retries-evidence")).toHaveCount(0);
    await expect(section(page).getByTestId("retry-finding")).toHaveCount(0);
    await expect(section(page).getByTestId("recurrence-finding")).toHaveCount(0);
    await expect(section(page).getByTestId("retries-within-none")).toHaveCount(0);
  };
  await noEvidence();
  const attemptRequests = () => requests.filter((r) => /\/runs\/990000144\/attempts\/|\/workflows\/9914\/runs/.test(r.path));
  expect(attemptRequests()).toEqual([]);

  // Nothing is requested on its own, and Try again neither requests anything nor turns the error into a success.
  const before = requests.length;
  await page.waitForTimeout(1500);
  expect(requests.length).toBe(before);
  await state.getByRole("button", { name: "Try again" }).click();
  await expect(state).toHaveAttribute("data-state", "error");
  await expect(state.getByRole("alert")).toContainText("GitHub did not report how many attempts the run has.");
  await page.waitForTimeout(1500);
  await expect(state).toHaveAttribute("data-state", "error");
  await noEvidence();
  expect(attemptRequests()).toEqual([]);
  expect(requests.length).toBe(before);
});

test("retries: another run starts from nothing; switching attempts keeps the run's evidence, labelled", async ({ page }) => {
  await forbidGitHub(page);
  await page.goto(synthetic(990000142));
  await section(page).getByTestId("load-retries").click();
  await expect(section(page).getByTestId("retries-evidence")).toHaveAttribute("data-run", "990000142");
  await expect(section(page).getByTestId("retries-viewed")).toHaveText("You are viewing attempt 3 of 3. These findings cover every attempt read, not only the one on screen.");

  // Another attempt of the same run: the same run-wide findings, and the attempt on screen is named.
  await page.goto(synthetic(990000142, "?attempt=1"));
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 3");
  await expect(section(page).getByTestId("retries-evidence")).toHaveAttribute("data-run", "990000142");
  await expect(section(page).getByTestId("retries-viewed")).toHaveText("You are viewing attempt 1 of 3. These findings cover every attempt read, not only the one on screen.");
  expect(await findings(page, "retry-finding")).toEqual(["check: insufficient evidence", "e2e: failed in every attempt observed", "integration: recovered on retry"]);

  // Another run: nothing of the first one is shown.
  await page.goto(synthetic(990000143));
  await expect(section(page).getByTestId("retries-state")).toHaveAttribute("data-state", "not loaded");
  await expect(section(page).getByTestId("retries-evidence")).toHaveCount(0);
  await expect(section(page).getByTestId("retry-finding")).toHaveCount(0);
  await section(page).getByTestId("load-retries").click();
  await expect(section(page).getByTestId("retries-evidence")).toHaveAttribute("data-run", "990000143");
  expect(await findings(page, "retry-finding")).toEqual(["lint: recovered on retry"]);

  // And back: not loaded again until asked.
  await page.goto(synthetic(990000142));
  await expect(section(page).getByTestId("retries-state")).toHaveAttribute("data-state", "not loaded");
});

test("retries: the History view reuses the history the section loaded; other sections still work", async ({ page }) => {
  await forbidGitHub(page);
  const requests = record(page);
  await page.goto(synthetic(990000142));
  await section(page).getByTestId("load-retries").click();
  await section(page).getByTestId("load-retry-history").click();
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "loaded");
  const listings = () => requests.filter((r) => r.path.includes("/actions/workflows/9912/runs")).length;
  expect(listings()).toBe(1);

  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByTestId("run-history")).toBeVisible();
  expect(listings()).toBe(1);
  await page.getByRole("tab", { name: "Execution graph" }).click();
  await expect(section(page).getByTestId("retries-evidence")).toBeVisible();
  await page.getByTestId("load-artifacts").click();
  await expect(page.getByTestId("artifacts-listing")).toHaveAttribute("data-state", "none listed");
});

test("retries: no horizontal overflow at a narrow width", async ({ page }) => {
  await forbidGitHub(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(synthetic(990000142));
  await section(page).getByTestId("load-retries").click();
  await section(page).getByTestId("load-retry-history").click();
  await expect(section(page).getByTestId("retries-history")).toHaveAttribute("data-state", "loaded");
  await section(page).getByTestId("retries-observations").locator("summary").click();
  await section(page).scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
