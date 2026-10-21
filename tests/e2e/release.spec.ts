// Release overview, phase detail and demo gallery, against the SYNTHETIC enterprise fixtures.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;
const phaseStatus = (page: Page, id: string) => page.getByTestId(`phase-${id}`).locator("[data-phase-status]");

test("gallery: pick a scenario variant, see which is selected, switch variants, and get the same state every time", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto("/?mode=fixtures");
  const gallery = page.getByTestId("demo-gallery");
  await expect(gallery.locator("article")).toHaveCount(8);
  await gallery.getByTestId("variant-release-prod-waiting").click();

  const strip = page.getByTestId("gallery-strip");
  await expect(strip).toContainText("Combined CI/CD release");
  await expect(strip.locator('[aria-current="page"]')).toHaveText("Waiting for Prod approval");
  await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "awaiting-approval");
  await expect(page.getByTestId("stop-banner")).toContainText("Paused: the prod deployment is awaiting approval (release-approvers).");

  await strip.getByRole("link", { name: "Released to Prod" }).click();
  await expect(strip.locator('[aria-current="page"]')).toHaveText("Released to Prod");
  await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "succeeded");
  await expect(page.getByTestId("stop-banner")).toHaveCount(0);

  // Deterministic: the same variant renders the same state after a reload.
  const before = await page.getByTestId("phase-rail").innerText();
  await page.reload();
  await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "succeeded");
  expect(await page.getByTestId("phase-rail").innerText()).toBe(before);
  expect(github).toEqual([]);
});

test("overview: CI, Dev, Test, Stage and Prod at a glance, with the grouping source stated", async ({ page }) => {
  await page.goto(run(990003001));
  const cards = page.getByTestId("phase-rail").locator(".phase-card");
  await expect(cards).toHaveCount(5);
  await expect(cards.locator(".pc-name")).toHaveText(["CI & artifact", "Dev", "Test", "Stage", "Prod"]);
  for (const card of await cards.all()) await expect(card).toBeInViewport();
  await expect(page.getByTestId("phase-source")).toContainText("Declared grouping. Phases declared in .github/actions-ui-phases.yml");
  await expect(page.getByTestId("phase-source")).toContainText("GitHub does not classify jobs into phases");
});

test("phase detail: clicking a phase expands only its jobs, with neighbours in other phases as links", async ({ page }) => {
  await page.goto(run(990005001));
  await page.getByTestId("phase-stage").click();
  await expect(page.getByTestId("phase-stage")).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/\/phases\/stage$/);
  const detail = page.getByTestId("phase-detail");
  await expect(detail.getByRole("heading", { level: 3 })).toContainText("Stage phase");
  const own = detail.locator('[data-testid="graph-node"]:not([data-node-key^="ext:"])');
  await expect(own).toHaveCount(4);
  await expect(detail.locator('[data-node-key="def:rollback-stage"]')).toContainText("recovery · runs on failure");
  await expect(detail.locator('[data-node-key="def:canary-stage"]')).toHaveAttribute("data-status", "failure");
  // A neighbour in another phase takes you to that phase.
  await expect(detail.locator('[data-node-key="ext:downstream:prod"]')).toContainText("1 dependent job");
  await detail.locator('[data-node-key="ext:downstream:prod"]').getByRole("button").click();
  await expect(page).toHaveURL(/\/phases\/prod$/);
  await expect(page.getByTestId("phase-detail").getByRole("heading", { level: 3 })).toContainText("Prod phase");
});

test("reusable CI: the called workflow opens as its own context; a job shows its steps and custom actions", async ({ page }) => {
  await page.goto(run(990001002));
  await page.getByTestId("phase-ci").click();
  await page.getByRole("button", { name: "Open called workflow ▸" }).click();
  await expect(page).toHaveURL(/\/phases\/ci\/calls\/ci$/);
  const called = page.getByTestId("called-workflow");
  await expect(called).toContainText("Caller job ci uses ./.github/workflows/_ci.yml");
  await expect(called.getByTestId("graph-node")).toHaveCount(6);
  // unit → integration, lint → build, unit → build, build → sbom: exactly the needs in _ci.yml.
  await expect(called.getByTestId("graph-edge")).toHaveCount(4);
  await called.locator('[data-node-key="def:unit"]').getByRole("button", { name: /windows/ }).click();
  const details = page.getByTestId("job-details");
  await expect(details.getByRole("heading", { level: 3 })).toHaveText("ci / unit (windows)");
  await expect(details.getByTestId("failure-summary")).toHaveText("GitHub's step data identifies the failed step: Unit tests.");
  await expect(details.locator("code.action.custom")).toContainText(["./.github/actions/setup-toolchain", "./.github/actions/run-tests"]);
  await page.getByRole("button", { name: "← Back to CI (reusable workflow)" }).click();
  await expect(page.getByTestId("called-workflow")).toHaveCount(0);
});

test("approval gates: pending, approved and rejected variants update the overview consistently", async ({ page }) => {
  await page.goto(run(990004001));
  await expect(phaseStatus(page, "stage")).toHaveAttribute("data-phase-status", "awaiting-approval");
  await expect(page.getByTestId("phase-stage")).toContainText("Awaiting approval · release-approvers");
  await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "pending");
  await expect(page.getByTestId("phase-prod")).toContainText("Waiting on Stage: awaiting approval");

  await page.getByTestId("gallery-strip").getByRole("link", { name: "Stage approved · deploying" }).click();
  await expect(phaseStatus(page, "stage")).toHaveAttribute("data-phase-status", "running");
  await expect(page.getByTestId("phase-stage")).toContainText("Approved by release-manager");

  await page.getByTestId("gallery-strip").getByRole("link", { name: "Prod approval rejected" }).click();
  await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "rejected");
  await expect(page.getByTestId("stop-banner")).toContainText("Stopped: the prod deployment was rejected by release-manager.");
  await page.getByTestId("phase-prod").click();
  await expect(page.getByTestId("phase-gate")).toContainText("Rejected by release-manager");
  await expect(page.getByTestId("phase-gate")).toContainText("source: approvals API");
});

test("failure and rollback: from the stop banner to the failed job, its step and its log, keeping context", async ({ page }) => {
  await page.goto(run(990005001));
  await expect(phaseStatus(page, "stage")).toHaveAttribute("data-phase-status", "recovered");
  await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "blocked");
  await expect(page.getByTestId("phase-prod")).toContainText("Blocked by Stage: failed · rolled back");
  await expect(page.getByTestId("stop-banner")).toContainText("Stopped in Stage: canary-stage failed at step “Canary analysis”. Recovery jobs ran and succeeded. Not run as a result: Prod.");

  await page.getByRole("button", { name: "Show the failed job" }).click();
  await expect(page).toHaveURL(/\/phases\/stage\/jobs\/\d+$/);
  const details = page.getByTestId("job-details");
  await expect(details.getByRole("heading", { level: 3 })).toHaveText("canary-stage");
  await expect(details.getByTestId("job-context")).toContainText("phase: Stage");
  await expect(details.getByTestId("failure-summary")).toHaveText("GitHub's step data identifies the failed step: Canary analysis.");
  await details.getByTestId("open-log").click();
  await expect(page).toHaveURL(/\/phases\/stage\/jobs\/\d+\/log$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("log-view")).toContainText("Canary analysis failed in canary-stage");
  // Context kept: the overview, the open phase and its graph are still on the page.
  await expect(page.getByTestId("phase-rail")).toBeVisible();
  await expect(page.getByTestId("phase-detail")).toContainText("Stage phase");

  await page.getByTestId("gallery-strip").getByRole("link", { name: "Prod deploy failed · rollback failed" }).click();
  await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "recovery-failed");
  await expect(page.getByTestId("stop-banner")).toContainText("A recovery job also failed.");
});

test("switching between the overview and the raw execution graph keeps the selected job", async ({ page }) => {
  await page.goto(run(990005001));
  await page.getByRole("button", { name: "Show the failed job" }).click();
  const url = page.url();
  const jobId = /\/jobs\/(\d+)/.exec(url)![1];
  await page.getByRole("tab", { name: "Execution graph (all jobs)" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}\\?view=graph$`));
  await expect(page.locator('[data-node-key="def:canary-stage"]')).toHaveClass(/selected/);
  await expect(page.getByTestId("graph-node")).toHaveCount(17);
  await page.getByRole("tab", { name: "Release overview" }).click();
  await expect(page).toHaveURL(new RegExp(`/phases/stage/jobs/${jobId}$`));
  await expect(page.getByTestId("phase-detail")).toContainText("Stage phase");
});

test("large platform release: the overview stays readable and drilling down shows a readable phase graph", async ({ page }) => {
  await page.goto(run(990006002));
  const cards = page.getByTestId("phase-rail").locator(".phase-card");
  await expect(cards).toHaveCount(5);
  for (const card of await cards.all()) await expect(card).toBeInViewport();
  const nameSize = await cards.first().locator(".pc-name").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(nameSize).toBeGreaterThanOrEqual(14);
  await expect(page.getByTestId("job-list")).toContainText("Jobs (79)");
  await cards.nth(3).focus();
  await page.keyboard.press("Enter");
  const detail = page.getByTestId("phase-detail");
  await expect(detail.getByRole("heading", { level: 3 })).toContainText("Stage phase");
  await expect(detail.locator('[data-node-key="def:smoke-billing-stage"]')).toHaveAttribute("data-status", "failure");
  const zoom = Number((await detail.locator(".zoom-level").textContent())!.replace("%", ""));
  expect(zoom).toBeGreaterThanOrEqual(80);
});

test("grouping is labelled inferred when only environments are available, and absent when nothing supports it", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000102");
  await expect(page.getByTestId("phase-source")).toContainText("Inferred grouping. Phases inferred from `environment:` in the workflow file");

  await page.goto("/?mode=fixtures#/runs/GauJosh/gha-ui-fixtures/39366120652");
  await expect(page.getByRole("tab", { name: "Release overview" })).toBeDisabled();
  await expect(page.getByTestId("overview-unavailable")).toContainText("declares no phases and no deployment environments");
  await expect(page.getByTestId("graph-edge")).toHaveCount(5);
});

test.describe("79-job platform release: focused, readable views", () => {
  test("opens on the release overview, not the all-jobs graph", async ({ page }) => {
    await page.goto(run(990006002));
    await expect(page.getByRole("tab", { name: "Release overview" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("phase-rail")).toBeVisible();
    await expect(page.getByTestId("stop-banner")).toContainText("Stopped in Stage: smoke-billing-stage failed");
    await expect(page.getByTestId("graph-viewport")).toHaveCount(0);
  });

  test("a focused phase: its own jobs in service lanes, neighbours summarised, and the scope stated", async ({ page }) => {
    await page.goto(run(990006002, "/phases/stage"));
    const detail = page.getByTestId("phase-detail");
    await expect(detail.getByTestId("phase-scope")).toContainText("Scoped view. 14 jobs in Stage and the 25 dependencies between them.");
    await expect(detail.getByTestId("phase-scope")).toContainText("needs 7 jobs in Test");
    await expect(detail.getByTestId("phase-scope")).toContainText("6 jobs in Prod need this phase");
    const ext = detail.locator('[data-testid="graph-node"][data-node-key^="ext:"]');
    await expect(ext).toHaveCount(2);
    await expect(detail.locator('[data-node-key="ext:upstream:test"]')).toContainText("7 prerequisite jobs");
    await expect(detail.locator('[data-node-key="ext:downstream:prod"]')).toContainText("6 dependent jobs");
    await expect(detail.getByTestId("lane-band")).toHaveText(["api", "web", "worker", "billing", "search", "notifications", "Other jobs"]);
    // Only 13 edges cross to other phases (via the two summaries) instead of 84 individual ones.
    await expect(detail.locator('[data-testid="graph-edge"][data-from^="ext:"], [data-testid="graph-edge"][data-to^="ext:"]')).toHaveCount(13);
    // Labels stay readable without zooming out.
    const zoom = Number((await detail.locator(".zoom-level").textContent())!.replace("%", ""));
    expect(zoom).toBeGreaterThanOrEqual(80);
    const nameSize = await detail.locator('[data-node-key="def:smoke-billing-stage"] .gnode-name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(nameSize * (zoom / 100)).toBeGreaterThanOrEqual(11);
    // Summaries lead to the related phases.
    await detail.getByRole("button", { name: "needs 7 jobs in Test" }).click();
    await expect(page).toHaveURL(/\/phases\/test$/);
  });

  test("selecting a job emphasises its direct prerequisites and dependents; all edges can be revealed", async ({ page }) => {
    await page.goto(run(990006002, "/phases/stage"));
    const detail = page.getByTestId("phase-detail");
    await detail.locator('[data-node-key="def:smoke-billing-stage"] .gnode-main').click();
    await expect(detail.locator('[data-node-key="def:smoke-billing-stage"]')).toHaveClass(/selected/);
    const highlighted = detail.locator("[data-testid=graph-edge].hl");
    await expect(highlighted).toHaveCount(3);
    const hl = await highlighted.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-from")}->${e.getAttribute("data-to")}`).sort());
    expect(hl).toEqual(["def:deploy-billing-stage->def:smoke-billing-stage", "def:smoke-billing-stage->def:rollback-stage", "def:smoke-billing-stage->ext:downstream:prod"]);
    expect(await detail.locator("[data-testid=graph-edge].faded").count()).toBeGreaterThan(20);
    await expect(detail.locator('[data-node-key="def:deploy-billing-stage"]')).toHaveClass(/related/);
    await expect(detail.locator('[data-node-key="def:smoke-api-stage"]')).toHaveClass(/dimmed/);

    await detail.getByRole("button", { name: "Show all edges" }).click();
    await expect(detail.getByTestId("graph-viewport")).toHaveAttribute("data-edge-mode", "all");
    await expect(detail.locator("[data-testid=graph-edge].faded")).toHaveCount(0);
  });

  test("the raw graph keeps every edge: junctions in focused mode, individual edges on request, phases and lanes labelled", async ({ page }) => {
    await page.goto(run(990006002, "?view=graph"));
    const viewport = page.getByTestId("graph-viewport");
    await expect(page.getByTestId("graph-node")).toHaveCount(58);
    await expect(page.getByTestId("group-frame")).toHaveText(["CI, security & artifact", "Dev", "Test", "Stage", "Prod"]);
    await expect(page.getByTestId("lane-band").first()).toHaveText("api");
    const junctions = await page.getByTestId("graph-junction").count();
    expect(junctions).toBeGreaterThan(0);
    const bundledEdges = await page.getByTestId("graph-edge").count();
    await page.getByRole("button", { name: "Show all edges" }).click();
    await expect(viewport).toHaveAttribute("data-edge-mode", "all");
    await expect(page.getByTestId("graph-junction")).toHaveCount(0);
    expect(await page.getByTestId("graph-edge").count()).toBeGreaterThan(bundledEdges);
    await expect(page.locator(".zoom-level")).toHaveText("80%");
  });

  test("selection persists across overview, phase, job and raw graph", async ({ page }) => {
    await page.goto(run(990006002));
    await page.getByRole("button", { name: "Show the failed job" }).click();
    await expect(page).toHaveURL(/\/phases\/stage\/jobs\/\d+$/);
    const jobId = /\/jobs\/(\d+)/.exec(page.url())![1];
    await expect(page.getByTestId("job-details").getByRole("heading", { level: 3 })).toHaveText("smoke-billing-stage");
    await page.getByRole("tab", { name: "Execution graph (all jobs)" }).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}\\?view=graph$`));
    await expect(page.locator('[data-node-key="def:smoke-billing-stage"]')).toHaveClass(/selected/);
    await expect(page.getByTestId("job-details").getByRole("heading", { level: 3 })).toHaveText("smoke-billing-stage");
    await page.getByRole("tab", { name: "Release overview" }).click();
    await expect(page).toHaveURL(new RegExp(`/phases/stage/jobs/${jobId}$`));
    await expect(page.getByTestId("phase-detail").locator('[data-node-key="def:smoke-billing-stage"]')).toHaveClass(/selected/);
    await page.getByTestId("job-details").getByTestId("open-log").click();
    await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  });

  test("the rollout variant keeps running, approved and not-yet-started work distinct", async ({ page }) => {
    await page.goto(run(990006003));
    await expect(phaseStatus(page, "prod")).toHaveAttribute("data-phase-status", "running");
    await expect(page.getByTestId("phase-prod")).toContainText("Approved by release-manager");
    await expect(page.getByTestId("phase-prod-counts")).toContainText("running");
    await expect(page.getByTestId("phase-prod-counts")).toContainText("not started");
    await page.getByTestId("phase-prod").click();
    await expect(page.getByTestId("phase-detail").locator('[data-node-key="def:deploy-api-prod"]')).toHaveAttribute("data-status", "in_progress");
  });
});
