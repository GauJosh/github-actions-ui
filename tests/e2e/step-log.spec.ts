// Step-to-log navigation: selecting a step opens the log at its output (mapping v2, docs/ARCHITECTURE.md §8),
// with explicit approximate and unavailable states, URL state, and the existing loading safeguards.
import { expect, test, type Page } from "@playwright/test";
import { S09, diagnosticEvents, forbidGitHub, instrument } from "./support";

const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;
const s09Step = (fault = "") => `/?mode=fixtures${fault}#/runs/${S09.owner}/${S09.repo}/${S09.runId}/jobs/${S09.jobId}/steps/2`;

async function openFailedSmokeJob(page: Page): Promise<string> {
  await page.goto(run(990006002));
  await page.getByRole("button", { name: "Show the failed job" }).click();
  await expect(page).toHaveURL(/\/phases\/stage\/jobs\/\d+$/);
  return /\/jobs\/(\d+)/.exec(page.url())![1]!;
}

async function selectInPhase(page: Page, nodeKey: string, step: string) {
  await page.goto(run(990006002, "/phases/stage"));
  await page.getByTestId("phase-detail").locator(`[data-node-key="${nodeKey}"] .gnode-main`).click();
  await page.getByTestId("job-details").getByTestId("step-link").filter({ hasText: step }).click();
}

test("a failed CD step opens the log at its first error line, highlighted, in view, within the step's shaded lines", async ({ page }) => {
  const github = await forbidGitHub(page);
  const jobId = await openFailedSmokeJob(page);
  await page.getByTestId("failed-step-link").click();
  await expect(page).toHaveURL(new RegExp(`/phases/stage/jobs/${jobId}/steps/2$`));

  const locator = page.getByTestId("step-locator");
  await expect(locator).toHaveAttribute("data-state", "found");
  await expect(locator).toContainText("Step 2: Smoke tests");
  await expect(page.getByTestId("step-range")).toHaveText("Lines 8–20. Showing its first error line (18). Step start");
  await expect(page.getByTestId("step-errors")).toContainText("Error lines in this step:");
  await expect(page.getByTestId("step-errors").getByRole("link")).toHaveText(["18", "19"]);
  await expect(locator).toContainText("GitHub runner log markers may not always give exact step boundaries.");

  const highlighted = page.locator(".row.highlighted");
  await expect(highlighted).toHaveAttribute("data-line", "18");
  await expect(highlighted).toContainText("##[error][synthetic] Smoke tests failed: health check returned 503");
  await expect(highlighted).toBeInViewport();
  await expect(page.locator('.row[data-line="8"]')).toHaveClass(/in-step step-start/);
  // Essential output (the default) folds the previous step's `##[endgroup]`; All output shows every line.
  await expect(page.locator('.row[data-line="7"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "All output" }).click();
  await expect(page.locator('.row[data-line="7"]')).not.toHaveClass(/in-step/);
  await expect(page.locator('.row[data-line="21"]')).not.toHaveClass(/in-step/);
  await expect(highlighted).toHaveAttribute("data-line", "18");
  await expect(page.getByTestId("job-details").locator('.step[aria-current="step"]')).toContainText("Smoke tests");
  expect(github).toEqual([]);
});

test("a successful step with known boundaries opens at its first line, without error marks", async ({ page }) => {
  await selectInPhase(page, "def:deploy-billing-stage", "Wait for rollout");
  await expect(page).toHaveURL(/\/phases\/stage\/jobs\/\d+\/steps\/\d+$/);
  const locator = page.getByTestId("step-locator");
  await expect(locator).toHaveAttribute("data-state", "found");
  await expect(locator).toContainText("Step 5: Wait for rollout");
  await expect(page.getByTestId("step-range")).toContainText("Showing its first line.");
  await expect(page.getByTestId("step-errors")).toHaveCount(0);
  const highlighted = page.locator(".row.highlighted");
  await expect(highlighted).toContainText("##[group]Run kubectl rollout status deployment");
  await expect(highlighted).toHaveClass(/step-start/);
  await expect(highlighted).toBeInViewport();
});

test("ambiguous boundaries are labelled approximate, with the reason", async ({ page }) => {
  // Rollback jobs emulate an older runner that does not mark composite actions' inner steps.
  await selectInPhase(page, "def:rollback-stage", "Roll back with Helm");
  const locator = page.getByTestId("step-locator");
  await expect(locator).toHaveAttribute("data-state", "approximate");
  await expect(page.getByTestId("step-range")).toContainText("Approximately lines");
  await expect(page.getByTestId("step-approximate")).toContainText("Step boundaries approximate.");
  await expect(page.getByTestId("step-approximate")).toContainText("The log has 2 top-level “Run” markers for 1 executed run step.");
  await page.locator("details.diagnostics summary").click();
  await expect(page.getByTestId("diag-mapping")).toHaveText("approximate");
});

test("URL state: step and line survive back/forward and view switches, and the user can return to the job details", async ({ page }) => {
  const jobId = await openFailedSmokeJob(page);
  const jobUrl = page.url();
  await page.getByTestId("failed-step-link").click();
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "18");

  // A line inside the step keeps the step in the URL.
  await page.getByTestId("step-errors").getByRole("link", { name: "19" }).click();
  await expect(page).toHaveURL(new RegExp(`/phases/stage/jobs/${jobId}/steps/2/L19$`));
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "19");
  await expect(page.getByTestId("step-range")).toContainText("Showing line 19.");

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/steps/2$`));
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "18");
  await page.goBack();
  expect(page.url()).toBe(jobUrl);
  await expect(page.getByTestId("step-locator")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", "found");

  // Switching views keeps the job, step and log.
  await page.getByRole("tab", { name: "Execution graph (all jobs)" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}/steps/2\\?view=graph$`));
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "18");
  await page.getByRole("tab", { name: "Release overview" }).click();
  await expect(page).toHaveURL(new RegExp(`/phases/stage/jobs/${jobId}/steps/2$`));
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", "found");

  // Back to the job details without changing the URL.
  const here = page.url();
  await page.getByTestId("step-locator").getByRole("link", { name: "↑ Job details and steps" }).click();
  await expect(page.getByTestId("job-details")).toBeInViewport();
  expect(page.url()).toBe(here);

  // A step that was skipped has no output, and says so.
  await page.goto(page.url().replace(/\/steps\/2$/, "/steps/99"));
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByTestId("step-locator")).toContainText("Step 99 is not in GitHub's step list for this job.");
});

test("tail-first: a large log explains that steps need the full log; after an explicit full load the step is found, and a step without a marker gets a fallback", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000001/jobs/990000002/steps/2");
  const status = page.getByTestId("log-status");
  const locator = page.getByTestId("step-locator");
  await expect(status).toHaveAttribute("data-status", "tail-only", { timeout: 30_000 });
  await expect(locator).toHaveAttribute("data-state", "needs-full-log");
  await expect(locator).toContainText("Finding a step's lines needs the full log");
  await expect(locator).toContainText("the end of the log is shown below; failure evidence is usually there");
  await expect(page.getByTestId("tail-evidence")).toContainText("Synthetic failure: expected 1 but got 2");
  await expect(page.getByTestId("log-view")).toHaveCount(0);

  await page.getByRole("button", { name: /^Load full log \(.+\) for search and step navigation$/ }).click();
  await expect(status).toHaveAttribute("data-status", "complete", { timeout: 90_000 });
  // "Complete job" has no cleanup marker in this synthetic log, so the mapping is approximate, not exact.
  await expect(locator).toHaveAttribute("data-state", "approximate");
  await expect(page.getByTestId("step-approximate")).toContainText("No log marker was found for step 3.");
  const highlighted = page.locator(".row.highlighted");
  await expect(highlighted).toHaveAttribute("data-line", "460000");
  await expect(highlighted).toContainText("##[error]Process completed with exit code 1.");
  await expect(highlighted).toBeInViewport();

  await page.getByTestId("job-details").getByTestId("step-link").filter({ hasText: "Complete job" }).click();
  await expect(page).toHaveURL(/\/steps\/3$/);
  await expect(locator).toHaveAttribute("data-state", "unmatched");
  await expect(locator).toContainText("could not be established, so no lines are attributed to it");
  await expect(page.locator(".row.in-step")).toHaveCount(0);
  // Same loader: the full log was not downloaded again.
  await expect(status).toHaveAttribute("data-status", "complete");
});

test("pause and resume while a step is waiting for the full log; the step is then found", async ({ page }) => {
  await page.goto(s09Step());
  const status = page.getByTestId("log-status");
  const locator = page.getByTestId("step-locator");
  await expect(status).toHaveAttribute("data-status", "loading", { timeout: 30_000 });
  await expect(locator).toHaveAttribute("data-state", "waiting");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(status).toHaveAttribute("data-status", "cancelled");
  await expect(locator).toHaveAttribute("data-state", "paused");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(status).toHaveAttribute("data-status", "complete", { timeout: 90_000 });
  await expect(locator).toHaveAttribute("data-state", "found");
  await expect(locator).toContainText("Step 2: Generate large noisy log");
  const highlighted = page.locator(".row.highlighted");
  await expect(highlighted).toContainText("##[error]");
  await expect(highlighted).toBeInViewport();
});

test("worker recovery (A9): after a worker failure and reload, the step is located from the reloaded log", async ({ page }) => {
  await instrument(page);
  await page.goto(s09Step("&fixture-faults=worker-failures-1"));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete", { timeout: 90_000 });
  expect(await diagnosticEvents(page)).toEqual(expect.arrayContaining(["worker-failed", "reloading", "complete"]));
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", "found");
  await expect(page.locator(".row.highlighted")).toContainText("##[error]");
});
