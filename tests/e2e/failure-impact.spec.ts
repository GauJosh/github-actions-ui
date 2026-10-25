// Failure impact explorer (fixture mode, SYNTHETIC runs): entry point, graph emphasis per failure, links to the
// failed step's log, and what is said when dependencies are unknown.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
const node = (page: Page, key: string) => page.locator(`[data-testid=graph-node][data-node-key="${key}"]`);

test("two independent failures: blocked, possibly and ran-anyway jobs, with unrelated skips left out", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = new Set<string>();
  page.on("request", (r) => methods.add(r.method()));
  await page.goto(synthetic(990000108));
  await page.getByTestId("investigate-failure").click();
  await expect(page).toHaveURL(/\?view=graph&impact=all$/);

  const panel = page.getByTestId("failure-impact");
  await expect(panel.getByTestId("impact-summary")).toHaveText("2 failures · 2 not run because of a failure · 1 possibly");
  await expect(panel.getByTestId("impact-earliest")).toContainText("unit (shard 2)");
  await expect(panel.getByTestId("impact-earliest")).toContainText("not a confirmed cause");
  await expect(panel.getByTestId("impact-card")).toHaveCount(2);
  await expect(panel.getByTestId("impact-unrelated")).toContainText("docs");

  await expect(node(page, "def:unit")).toHaveAttribute("data-impact", "failed");
  await expect(node(page, "def:integration")).toHaveAttribute("data-impact", "failed");
  await expect(node(page, "def:build")).toHaveAttribute("data-impact", "upstream");
  await expect(node(page, "def:package")).toHaveAttribute("data-impact", "blocked");
  await expect(node(page, "def:publish")).toHaveAttribute("data-impact", "blocked");
  await expect(node(page, "def:rollback")).toHaveAttribute("data-impact", "possibly");
  await expect(node(page, "def:notify")).toHaveAttribute("data-impact", "ran");
  // Skipped by its own condition: still drawn (the whole graph stays inspectable), but not part of the impact.
  await expect(node(page, "def:docs")).not.toHaveAttribute("data-impact");
  await expect(node(page, "def:docs")).toHaveClass(/dimmed/);
  await expect(page.locator('[data-testid=graph-edge][data-from="def:unit"][data-to="def:package"]')).toHaveClass(/impact/);

  // One failure at a time, without leaving the graph.
  await panel.locator('[data-testid=impact-pick][data-key="def:integration"]').click();
  await expect(page).toHaveURL(/impact=def%3Aintegration$/);
  await expect(panel.getByTestId("impact-card")).toHaveCount(1);
  await expect(panel.getByTestId("impact-card")).toContainText("GitHub's step data names no failed step");
  await expect(node(page, "def:unit")).not.toHaveAttribute("data-impact");
  await expect(node(page, "def:package")).toHaveAttribute("data-impact", "blocked");

  // Evidence: the failed step's log, keeping the impact on the graph.
  await panel.locator('[data-testid=impact-pick][data-key="def:unit"]').click();
  await panel.getByTestId("impact-step-log").first().click();
  await expect(page).toHaveURL(/\/jobs\/\d+\/steps\/3\?view=graph&impact=def%3Aunit$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("job-details")).toContainText("unit (shard 2)");
  await expect(panel).toBeVisible();

  await expect(panel.getByTestId("impact-compare")).toHaveAttribute("href", /\?view=compare$/);
  await expect(panel.getByTestId("impact-search")).toHaveAttribute("href", /\?view=search$/);
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("failure-impact")).toHaveCount(0);
  await expect(node(page, "def:package")).not.toHaveAttribute("data-impact");
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("a single failure: the matrix leg, its blocked jobs, and a job that ran anyway", async ({ page }) => {
  await page.goto(synthetic(990000101, "?view=graph&impact=all"));
  const card = page.getByTestId("impact-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("impact-upstream")).toHaveText("Needs no other job.");
  await expect(card.locator('[data-reason="blocked"]')).toContainText("integration");
  await expect(card.locator('[data-reason="blocked"]')).toContainText("e2e");
  await expect(card.locator('[data-reason="ran-anyway"]')).toContainText("report");
  await expect(page.getByTestId("impact-pick")).toHaveCount(0);
});

test("without the workflow file, impact is not guessed", async ({ page }) => {
  await page.goto(synthetic(990000106, "?view=graph&impact=all"));
  const panel = page.getByTestId("failure-impact");
  await expect(panel.getByTestId("impact-summary")).toHaveText("1 failure");
  await expect(panel.getByTestId("impact-upstream")).toContainText("Unknown");
  await expect(panel.getByTestId("impact-notes")).toContainText("cannot be established");
  await expect(page.locator("[data-testid=graph-node][data-impact=blocked]")).toHaveCount(0);
});

test("no entry point when nothing failed", async ({ page }) => {
  await page.goto(synthetic(990000104));
  await expect(page.getByTestId("run-stats")).toBeVisible();
  await expect(page.getByTestId("investigate-failure")).toHaveCount(0);
});
