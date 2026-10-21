// Nested reusable workflows without a phase file (SYNTHETIC "shared CI/CD" scenario): the release overview built
// from the call hierarchy, nested job context and revisions, failure consequences, step-to-log, and fallbacks.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;
const phase = (page: Page, id: string) => page.getByTestId(`phase-${id}`);

test("no phase file and no environments in the caller: the overview is built from the called workflows", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto(run(990007001));
  await expect(page.getByRole("tab", { name: "Release overview" })).toHaveAttribute("aria-selected", "true");
  const cards: [string, string][] = [
    ["call:ci", "ci"],
    ["env:dev", "dev"],
    ["env:test", "test"],
    ["env:stage", "stage"],
    ["env:prod", "prod"],
  ];
  for (const [id, name] of cards) {
    await expect(phase(page, id)).toContainText(name);
    await expect(phase(page, id).locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "succeeded");
  }
  await expect(page.getByText("Phases inferred from `environment:` in the workflow files, including called workflows")).toBeVisible();
  await expect(page.getByTestId("phase-env:prod")).toContainText("Approved by release-manager");
  expect(github).toEqual([]);
});

test("CD policy failure: CI succeeded, DEV failed at the step and rolled back, later environments blocked (not failed)", async ({ page }) => {
  await page.goto(run(990007002));
  await expect(phase(page, "call:ci").locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "succeeded");
  await expect(phase(page, "env:dev").locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "recovered");
  for (const id of ["env:test", "env:stage", "env:prod"]) {
    await expect(phase(page, id).locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "blocked");
    // Its own jobs were skipped, not failed (the card names the upstream phase that failed).
    await expect(page.getByTestId(`phase-${id}-counts`)).toContainText("skipped");
    await expect(page.getByTestId(`phase-${id}-counts`)).not.toContainText("failed");
  }
  await expect(page.getByTestId("stop-banner")).toContainText("Stopped in dev: cd / DEV / Deploy failed at step “Run CD policy”");
  await expect(page.getByTestId("stop-banner")).toContainText("Not run as a result: test, stage, prod");
});

test("the failed nested job: its call chain, file revision, caller-level dependency, steps and step-to-log", async ({ page }) => {
  await page.goto(run(990007002));
  await page.getByRole("button", { name: "Show the failed job" }).click();
  const details = page.getByTestId("job-details");
  await expect(details.getByRole("heading", { level: 3 })).toHaveText("cd / DEV / Deploy");
  const where = details.getByTestId("job-workflow-context");
  await expect(where).toContainText("Inside cd › DEV");
  await expect(where).toContainText("fixtures/shared-workflows/.github/workflows/deploy-environment.yml");
  await expect(where).toContainText("the calling workflow's commit (GitHub's rule for `./` references)");
  await expect(where).toContainText("filled with the calling job's literal value");
  await expect(details.locator(".dep.caller-level")).toContainText("ci");
  await expect(details.getByTestId("failure-summary")).toHaveText("GitHub's step data identifies the failed step: Run CD policy.");
  await expect(details.locator(".action.custom").first()).toBeVisible();

  await details.getByTestId("failed-step-link").click();
  await expect(page).toHaveURL(/\/phases\/env%3Adev\/jobs\/\d+\/steps\/3$/);
  const locator = page.getByTestId("step-locator");
  await expect(locator).toHaveAttribute("data-state", "found");
  await expect(page.locator(".row.highlighted")).toContainText("##[error][synthetic] Run CD policy failed");

  // The selection survives switching to the all-jobs graph, where the job sits inside its call.
  await page.getByRole("tab", { name: "Execution graph (all jobs)" }).click();
  await expect(page).toHaveURL(/\/steps\/3\?view=graph$/);
  await expect(page.locator('[data-node-key="def:cd/deploy-dev/deploy"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-node-key="def:cd/deploy-dev/deploy"]')).toContainText("in cd › DEV");
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", "found");
});

test("caller-level needs are drawn distinctly from needs inside a workflow", async ({ page }) => {
  await page.goto(run(990007001, "?view=graph"));
  await page.getByRole("button", { name: "Show all edges" }).click();
  await expect(page.locator('[data-testid=graph-edge][data-from="def:ci"][data-to="def:cd/deploy-dev/deploy"]')).toHaveClass(/\bcall\b/);
  await expect(page.locator('[data-testid=graph-edge][data-from="def:cd/deploy-dev/deploy"][data-to="def:cd/deploy-dev/smoke"]')).not.toHaveClass(/\bcall\b/);
  await expect(page.locator(".gnode-name").getByText("Deploy", { exact: true })).toHaveCount(4); // one per call of the same workflow
});

test("revision not reported: the CD file is not read; the call stays one node and the overview explains why", async ({ page }) => {
  await page.goto(run(990007003));
  await expect(page.getByTestId("overview-unavailable")).toContainText("some called workflows could not be read");
  await expect(page.getByTestId("graph-viewport")).toBeVisible();
  await expect(page.getByText("GitHub did not report which commit `release/v2`")).toBeVisible();
  await expect(page.locator('[data-node-key="def:cd"]')).toContainText("cd");
});

test("nested file missing or no access: explicit reasons, nothing guessed", async ({ page }) => {
  await page.goto(run(990007004));
  await expect(phase(page, "env:dev")).toBeVisible();
  await page.getByRole("tab", { name: "Execution graph (all jobs)" }).click();
  await expect(page.getByText(/deploy-environment\.yml was not found/).first()).toBeVisible();

  await page.goto(run(990007005));
  await expect(page.getByTestId("overview-unavailable")).toBeVisible();
  await expect(page.getByText(/cannot read fixtures\/shared-workflows/).first()).toBeVisible();
});
