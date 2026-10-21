// Environment grouping and the grouped execution graph (SYNTHETIC "promotion checks" scenario, no phase file):
// readiness checks before PROD and PROD-DR are grouped with those environments, not DEV; each environment is a
// framed subgraph laid out by its own needs, and parallel environments stand side by side.
import { expect, test, type Page } from "@playwright/test";
import { forbidGitHub } from "./support";

const run = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/enterprise/${id}${rest}`;
const phase = (page: Page, id: string) => page.getByTestId(`phase-${id}`);
const node = (page: Page, key: string) => page.locator(`[data-testid=graph-node][data-node-key="${key}"]`);

test("readiness checks are grouped with the environment their call names, with the evidence, not under DEV", async ({ page }) => {
  const github = await forbidGitHub(page);
  await page.goto(run(990008001));
  for (const id of ["call:ci", "env:dev", "env:prod", "env:prod-dr"]) await expect(phase(page, id).locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "succeeded");
  await expect(phase(page, "env:dev")).toContainText("3 succeeded · 1 skipped"); // its rollback was not needed
  await expect(phase(page, "env:prod")).toContainText("4 succeeded · 1 skipped");
  await expect(page.getByTestId("phase-other")).toHaveCount(0);

  await phase(page, "env:dev").click();
  const detail = page.getByTestId("phase-detail");
  await expect(detail.getByTestId("graph-node").filter({ hasText: "readiness" })).toHaveCount(0);
  await phase(page, "env:prod").click();
  await expect(node(page, "def:cd/ready-prod")).toBeVisible();
  await node(page, "def:cd/ready-prod").getByRole("button").first().click();
  const env = page.getByTestId("job-environment");
  await expect(env).toHaveAttribute("data-provenance", "input");
  await expect(env).toContainText("Environment: prod (from the caller's input): the call is called with `target: prod`.");
  expect(github).toEqual([]);
});

test("execution graph: one column per environment, jobs top to bottom by needs; PROD and PROD-DR in parallel; selection and edge modes kept", async ({ page }) => {
  await page.goto(run(990008001, "?view=graph"));
  const frames = page.getByTestId("group-frame");
  await expect(frames).toHaveText(["ci", "dev", "prod", "prod-dr"]);
  const box = async (name: string) => (await page.locator(`[data-testid=group-frame][data-group="${name}"]`).boundingBox())!;
  const [dev, prod, dr] = [await box("dev"), await box("prod"), await box("prod-dr")];
  // PROD and PROD-DR do not depend on each other: same column, stacked, both right of DEV.
  expect(Math.abs(prod.x - dr.x)).toBeLessThan(2);
  expect(dr.y).toBeGreaterThanOrEqual(prod.y + prod.height - 1);
  expect(prod.x).toBeGreaterThan(dev.x + dev.width);
  // Inside PROD, top to bottom by needs: readiness, deployment, smoke test, validation, rollback.
  const y = async (key: string) => (await node(page, key).boundingBox())!.y;
  const order = ["def:cd/ready-prod", "def:cd/deploy-prod/deploy", "def:cd/deploy-prod/smoke", "def:cd/prod-validation", "def:cd/prod-rollback"];
  for (let i = 1; i < order.length; i++) expect(await y(order[i]!), order[i]).toBeGreaterThan(await y(order[i - 1]!));
  // The environment columns are much narrower than the old single row.
  expect(prod.width).toBeLessThan(400);
  // The cross-environment edge from DEV's validation to the PROD check is drawn; nothing is invented between PROD and PROD-DR.
  await page.getByRole("button", { name: "Show all edges" }).click();
  await expect(page.locator('[data-testid=graph-edge][data-from="def:cd/dev-validation"][data-to="def:cd/ready-prod"]')).toHaveCount(1);
  await expect(page.locator('[data-testid=graph-edge][data-from^="def:cd/prod-"][data-to^="def:cd/ready-prod-dr"]')).toHaveCount(0);
  // Selection still focuses the selected job's edges.
  await page.getByRole("button", { name: "Focused" }).click();
  await page.getByRole("button", { name: "Fit" }).click();
  await node(page, "def:cd/prod-dr-validation").locator(".gnode-main").click();
  await expect(page.getByTestId("graph-viewport")).toHaveAttribute("data-edge-mode", "focused");
  await expect(page.locator("[data-testid=graph-edge].hl")).toHaveCount(2);
});

test("a failed PROD-DR validation: rollback ran in PROD-DR only; states stay distinct in the graph", async ({ page }) => {
  await page.goto(run(990008002));
  await expect(phase(page, "env:prod-dr").locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "recovered");
  await expect(phase(page, "env:prod").locator("[data-phase-status]")).toHaveAttribute("data-phase-status", "succeeded");
  await page.goto(run(990008002, "?view=graph"));
  await expect(node(page, "def:cd/prod-dr-validation")).toHaveAttribute("data-status", "failure");
  await expect(node(page, "def:cd/prod-dr-rollback")).toHaveAttribute("data-status", "success");
  await expect(node(page, "def:cd/prod-rollback")).toHaveAttribute("data-status", "skipped");
});
