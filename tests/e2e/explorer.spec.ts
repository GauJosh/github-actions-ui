// Pipeline explorer in fixture mode: graph evidence, no invented edges, navigation, and the route to logs.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const edges = (page: Page) =>
  page.getByTestId("graph-edge").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-from")}->${e.getAttribute("data-to")}`).sort());
const node = (page: Page, key: string) => page.locator(`[data-testid="graph-node"][data-node-key="${key}"]`);

test("real run s05: edges exactly as declared in the workflow file at the run's commit; failed job to its log", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto("/?mode=fixtures#/runs/GauJosh/gha-ui-fixtures/39366120652");
  await expect(page.getByTestId("graph-evidence")).toContainText("Dependencies from .github/workflows/s05-cascade-skip.yml at 4e73dc9 (the run's commit) · 4 of 4 jobs matched.");
  expect(await edges(page)).toEqual(["def:build->def:report", "def:build->def:test", "def:deploy->def:report", "def:test->def:deploy", "def:test->def:report"].sort());
  await expect(node(page, "def:build")).toHaveAttribute("data-status", "failure");
  await expect(node(page, "def:deploy")).toHaveAttribute("data-status", "skipped");

  await node(page, "def:build").getByRole("button").first().click();
  await expect(node(page, "def:build")).toHaveClass(/selected/);
  const details = page.getByTestId("job-details");
  await expect(details).toContainText("Needed by");
  await expect(details.getByTestId("failure-summary")).toContainText("GitHub's step data identifies the failed step");
  await details.getByTestId("open-log").click();
  await expect(page).toHaveURL(/\/jobs\/\d+\/log$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  // The graph stays on the page while the log is open.
  await expect(page.getByTestId("graph-viewport")).toBeVisible();
  expect(github).toEqual([]);
});

test("real KAI CI run: a 7-job matrix grouped from a templated name, failures first, and its dependent", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/GauJosh/kubernetes-ai-investigator/38850578511");
  const matrix = node(page, "def:test");
  await expect(matrix).toContainText("matrix · 7 jobs");
  await expect(matrix).toContainText("2 failed · 5 succeeded");
  await expect(matrix.locator(".member").first()).toContainText("windows-latest");
  expect(await edges(page)).toEqual(["def:test->def:build"]);
  await matrix.getByRole("button", { name: /windows-latest, Python 3.10/ }).click();
  await expect(page.getByTestId("job-details")).toContainText("test (windows-latest, Python 3.10)");
});

test("synthetic CI: parallel jobs, matrix legs, fan-in; selecting a leg from the graph or the job list", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000101");
  await expect(page.getByTestId("graph-edge")).toHaveCount(11);
  const unit = node(page, "def:unit");
  await expect(unit).toContainText("1 failed");
  await unit.getByRole("button", { name: /node 20/ }).click();
  await expect(page.getByTestId("job-details").getByRole("heading", { level: 3 })).toHaveText("unit (node 20)");
  await expect(page.getByTestId("job-list").getByRole("button", { name: /node 20/ })).toHaveAttribute("aria-current", "true");

  await page.getByTestId("job-list").getByRole("button", { name: /^.*report/ }).click();
  await expect(node(page, "def:report")).toHaveClass(/selected/);
  await expect(page.getByTestId("job-details")).toContainText("Needs");
  // Edges touching the selection are highlighted.
  await expect(page.locator('[data-testid="graph-edge"].hl')).toHaveCount(6);
});

test("missing workflow file: no edges are drawn and the limitation is explicit", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000106");
  await expect(page.getByTestId("graph-evidence")).toContainText("Dependencies unavailable. The token cannot read the workflow file");
  expect(await edges(page)).toEqual([]);
  await expect(node(page, "name:matrix:test")).toContainText("(grouped by name)");
  await page.getByTestId("job-list").getByRole("button", { name: /audit/ }).click();
  await expect(page.getByTestId("job-details")).toContainText("GitHub returned no step data for this job.");
  await expect(page.getByTestId("job-details")).toContainText("unknown (no workflow file)");
});

test("workflow file that does not match the jobs: the unmatched job has no edges", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000107");
  await expect(page.getByTestId("graph-evidence")).toContainText("1 job could not be matched to the workflow file");
  const compile = page.locator('[data-testid="graph-node"][data-node-key^="job:"]');
  await expect(compile).toContainText("not matched to the workflow file");
  const key = await compile.getAttribute("data-node-key");
  expect((await edges(page)).some((e) => e.includes(key!))).toBe(false);
  // `build` has no job in this run: listed as declared context, never drawn as a job.
  await expect(node(page, "def:build")).toHaveCount(0);
  await expect(page.getByTestId("declared-context")).toContainText("build");
});

test("reusable workflows and an in-progress deployment are shown with their real states", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000103");
  const tests = node(page, "def:tests");
  await expect(tests).toContainText("calls ./.github/workflows/_tests.yml");
  await tests.getByRole("button", { name: /unit/ }).click();
  await expect(page.getByTestId("job-details")).toContainText("Dependencies inside the called workflow are not shown.");

  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000102?view=graph");
  await expect(node(page, "def:deploy-prod")).toContainText("1 running · 1 waiting · 1 queued");
  await expect(node(page, "def:verify-prod")).toHaveCount(0);
  await expect(page.getByTestId("declared-context")).toContainText("verify-prod");
  await expect(page.getByTestId("declared-context")).toContainText("GitHub may not have created them yet");
  await expect(page.getByRole("heading", { name: "Still running" })).toBeVisible();
});

test("large graph: opens readable on the failure, zooms, fits, pans, and is keyboard navigable", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000105");
  await expect(page.getByTestId("graph-node")).toHaveCount(108);
  const zoom = page.locator(".zoom-level");
  await expect(zoom).toHaveText("80%");
  await expect(node(page, "def:s6-j3")).toBeInViewport();
  await expect(page.locator(".minimap")).toBeVisible();

  await page.getByRole("button", { name: "Fit" }).click();
  const fitted = Number((await zoom.textContent())!.replace("%", ""));
  expect(fitted).toBeLessThan(80);

  const viewport = page.getByTestId("graph-viewport");
  await viewport.focus();
  await page.keyboard.press("+");
  await expect(zoom).not.toHaveText(`${fitted}%`);
  const stage = page.locator(".graph-stage");
  const before = await stage.getAttribute("style");
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + box.height - 20, { steps: 5 });
  await page.mouse.up();
  expect(await stage.getAttribute("style")).not.toBe(before);

  // Tab from the viewport into the graph's job buttons; Enter selects.
  await viewport.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("job-details")).toBeVisible();
});

test("the run's identity is kept in the URL across graph, job and log, and the breadcrumb leads back", async ({ page }) => {
  await page.goto("/?mode=fixtures#/runs/fixtures/synthetic/990000101");
  await node(page, "def:lint").getByRole("button").first().click();
  await expect(page).toHaveURL(/#\/runs\/fixtures\/synthetic\/990000101\/jobs\/\d+$/);
  await page.getByTestId("open-log").click();
  await expect(page).toHaveURL(/#\/runs\/fixtures\/synthetic\/990000101\/jobs\/\d+\/log$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await page.goBack();
  await expect(page.getByTestId("log-status")).toHaveCount(0);
  await expect(node(page, "def:lint")).toHaveClass(/selected/);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "fixtures/synthetic" }).click();
  await expect(page).toHaveURL(/#\/repos\/fixtures\/synthetic$/);
});
