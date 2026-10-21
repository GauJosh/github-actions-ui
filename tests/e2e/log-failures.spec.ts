// Failure detection and step-first log output (docs/ARCHITECTURE.md §8.1), in live mode against a mocked
// api.github.com serving SYNTHETIC logs. No real GitHub request is made; the token is a fake value generated per run.
import { expect, test, type Page } from "@playwright/test";
import { NODE_ACTION_JOB, NODE_ACTION_STEPS, SIGNATURE_CASES } from "../../tools/fixture-server/failure-logs.ts";

const ORIGIN = "http://127.0.0.1:4317";
const FAKE_TOKEN = `e2e-fake-token-not-real-${Math.random().toString(36).slice(2, 10)}`;
const stamp = "2026-10-21T10:00:00.0000000Z ";

type Steps = readonly (readonly [string, string])[];

/** Serves one failed job with `steps` (or no step data) and the log `lines`. Records the request methods. */
async function mockGitHub(page: Page, lines: string[], steps: Steps | null): Promise<string[]> {
  const methods: string[] = [];
  const log = Buffer.from(lines.join("\n") + "\n");
  const cors = {
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-headers": "authorization, accept, range, x-github-api-version",
    "access-control-expose-headers": "Link, Content-Length, Content-Range, x-ratelimit-remaining, x-ratelimit-reset",
  };
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    methods.push(request.method());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET, HEAD" } });
    if (path === "/repos/acme/app/actions/runs/1") {
      return route.fulfill({
        json: { id: 1, display_title: "Release notes", status: "completed", conclusion: "failure", run_attempt: 1, head_branch: "main", head_sha: "b".repeat(40), html_url: "https://github.com/acme/app/actions/runs/1", event: "push", path: ".github/workflows/release.yml" },
        headers: cors,
      });
    }
    if (path === "/repos/acme/app/actions/runs/1/jobs") {
      const list = steps?.map(([name, conclusion], i) => ({ number: i + 1, name, status: "completed", conclusion, started_at: null, completed_at: null }));
      return route.fulfill({
        json: { total_count: 1, jobs: [{ id: 2, name: "release", status: "completed", conclusion: "failure", started_at: null, completed_at: null, html_url: "https://github.com/acme/app/actions/runs/1/job/2", ...(list && { steps: list }) }] },
        headers: cors,
      });
    }
    if (path === "/repos/acme/app/actions/jobs/2/logs") {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers()["range"] ?? "");
      if (request.method() === "HEAD") return route.fulfill({ status: 200, headers: { ...cors, "content-length": String(log.length) }, body: "" });
      if (!range) return route.fulfill({ status: 200, headers: cors, body: log });
      const [start, end] = [Number(range[1]), Math.min(Number(range[2]), log.length - 1)];
      return route.fulfill({ status: 206, headers: { ...cors, "content-range": `bytes ${start}-${end}/${log.length}` }, body: log.subarray(start, end + 1) });
    }
    return route.fulfill({ status: 404, json: { message: "Not Found" }, headers: cors });
  });
  return methods;
}

async function openJob(page: Page) {
  await page.goto("/");
  await page.getByTestId("token-input").fill(FAKE_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("GitHub Actions run URL").fill("https://github.com/acme/app/actions/runs/1");
  await page.getByRole("button", { name: "Open run" }).click();
  await page.getByTestId("job-list").getByRole("button", { name: /release/ }).click();
  await page.getByRole("button", { name: /^Open log/ }).click();
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
}
const row = (page: Page, line: number) => page.locator(`.row[data-line="${line}"]`);
const shownLines = (page: Page) => page.locator(".row[data-line]").evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-line"))));

test("the observed Node.js failure: recognised, counted, and the failed step opens on it with its stack trace", async ({ page }) => {
  const methods = await mockGitHub(page, NODE_ACTION_JOB, NODE_ACTION_STEPS);
  await openJob(page);

  // Errors is not zero, and the evidence names its tier.
  const errors = page.getByRole("group", { name: "Quick filters" }).locator('[data-filter="errors"]');
  await expect(errors.locator(".lchip-count")).toHaveText("1");
  await expect(errors).toHaveAttribute("title", "0 runner error annotations, 1 failure signatures, 0 lines that only look like errors");
  await expect(page.getByTestId("count-scope")).toHaveText("Counts in the whole job log:");

  // The job-level failure summary: which step failed (GitHub) and its strongest evidence.
  const failure = page.getByTestId("failed-step");
  await expect(failure).toHaveAttribute("data-step", "3");
  await expect(failure).toContainText("Step 3 · Run example/publish-notes@v1 failed (GitHub step result) · lines 13–29");
  await expect(failure.getByTestId("step-evidence")).toContainText("Line 21 failure signature Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@actions/core'");

  // Step-first: the failed step is open, the others collapsed.
  await expect(page.locator('[data-testid=log-step][data-step="3"]')).toHaveAttribute("data-collapsed", "false");
  await expect(page.locator('[data-testid=log-step][data-step="3"]')).toContainText("1 failure signature");
  await expect(page.locator('[data-testid=log-step][data-step="2"]')).toHaveAttribute("data-collapsed", "true");

  // From the evidence to the step: opens on the exception, highlighted, its trace and error code visible.
  await failure.getByRole("link", { name: "Open this step" }).click();
  await expect(page).toHaveURL(/\/jobs\/2\/steps\/3$/);
  const highlighted = page.locator(".row.highlighted");
  await expect(highlighted).toHaveAttribute("data-line", "21");
  await expect(highlighted.locator(".kbadge")).toHaveText("error code");
  await expect(highlighted).toBeInViewport();
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", "found");
  await expect(page.getByTestId("step-range")).toContainText("Showing its strongest error evidence (line 21).");
  await expect(page.getByTestId("step-signatures").getByRole("link")).toHaveText(["21"]);
  for (const line of [22, 25, 26, 27]) await expect(row(page, line)).toHaveAttribute("data-kind", "stack");
  await expect(row(page, 26)).toContainText("code: 'ERR_MODULE_NOT_FOUND'");
  // Output just before the failure stays visible.
  await expect(row(page, 17)).toContainText("node:internal/modules/esm/resolve:873");

  // Errors & warnings: the exception with its whole trace and the step header.
  await page.getByRole("tab", { name: "Errors & warnings" }).click();
  await page.getByLabel("Context lines").selectOption("0");
  await expect.poll(() => shownLines(page)).toEqual([13, 21, 22, 23, 24, 25, 26, 27]);
  expect(methods.every((m) => m === "GET" || m === "HEAD" || m === "OPTIONS")).toBe(true);
});

test("runner metadata and step definitions are collapsed but recoverable; All output restores every original line", async ({ page }) => {
  await mockGitHub(page, NODE_ACTION_JOB, NODE_ACTION_STEPS);
  await openJob(page);
  const setupStep = page.locator('[data-testid=log-step][data-step="1"]');
  await expect(setupStep).toHaveAttribute("data-collapsed", "true");
  await expect(row(page, 1)).toHaveCount(0);
  await setupStep.getByRole("button").click();
  await expect(setupStep).toHaveAttribute("data-collapsed", "false");
  const setup = page.locator('[data-testid=log-fold][data-start="1"]');
  await expect(setup).toContainText("runner setup");
  await setup.getByRole("button").click();
  await expect(row(page, 1)).toContainText("Current runner version: '2.337.0'");
  await expect(row(page, 7)).toContainText("Complete job name: release");

  // The failed step's `with:` inputs are folded as its definition, and expand to the original lines.
  const definition = page.locator('[data-testid=log-fold][data-start="14"]');
  await expect(definition).toContainText("step script and settings echoed by the runner");
  await definition.getByRole("button").click();
  await expect(row(page, 15)).toContainText("  channel: beta");

  await page.getByRole("tab", { name: "All output" }).click();
  await expect(page.getByTestId("log-step")).toHaveCount(0);
  await expect(page.locator("[data-testid=log-fold]")).toHaveCount(0);
  await expect.poll(() => shownLines(page)).toEqual(NODE_ACTION_JOB.map((_, i) => i + 1));
  // The text of every line, without the badge drawn beside it, is the original line.
  const texts = await page.locator(".row[data-line] .tx").evaluateAll((els) =>
    els.map((e) => {
      const copy = e.cloneNode(true) as HTMLElement;
      copy.querySelector(".kbadge")?.remove();
      return copy.textContent;
    }),
  );
  expect(texts).toEqual(NODE_ACTION_JOB);
});

test("Python, Java, shell and test failures are signatures; heuristics are marked as such; familiar words are not errors", async ({ page }) => {
  const output = SIGNATURE_CASES.flatMap((c) => c.lines);
  const lines = [...NODE_ACTION_JOB.slice(0, 12), `${stamp}##[group]Run ./scripts/check-all.sh`, `${stamp}##[endgroup]`, ...output.map((l) => stamp + l), `${stamp}##[error]Process completed with exit code 1.`, `${stamp}Cleaning up orphan processes`];
  await mockGitHub(page, lines, [
    ["Set up job", "success"],
    ["Run actions/checkout@v4", "success"],
    ["Run ./scripts/check-all.sh", "failure"],
    ["Complete job", "success"],
  ]);
  await openJob(page);
  await page.getByRole("tab", { name: "All output" }).click();
  const kinds = await page.locator(".row[data-line]").evaluateAll((rows) => Object.fromEntries(rows.map((r) => [Number(r.getAttribute("data-line")), r.getAttribute("data-kind")])));
  let offset = 15; // 1-based line of the first case line
  for (const c of SIGNATURE_CASES) {
    for (const [n, kind] of c.kinds) {
      const line = offset + n;
      // Rows beyond the rendered window are checked after scrolling.
      if (kinds[line] === undefined) {
        await page.getByTestId("log-view").evaluate((el, top) => (el.scrollTop = top), (line - 10) * 20);
        await expect(row(page, line)).toHaveAttribute("data-kind", kind === "output" ? /^(output|action-output)$/ : kind);
      } else expect(kinds[line] === "action-output" && kind === "output" ? "output" : kinds[line], `${c.name}: line ${line}`).toBe(kind);
    }
    offset += c.lines.length;
  }

  // Badges keep the tiers apart.
  await page.getByRole("tab", { name: "Errors & warnings" }).click();
  await page.getByLabel("Context lines").selectOption("0");
  const badges = await page.locator(".row[data-line] .kbadge").evaluateAll((els) => els.map((e) => e.getAttribute("data-badge")));
  expect(badges).toEqual(expect.arrayContaining(["signature", "text"]));
  const prose = 15 + SIGNATURE_CASES.slice(0, -1).reduce((s, c) => s + c.lines.length, 0);
  for (let line = prose; line < prose + SIGNATURE_CASES.at(-1)!.lines.length; line++) await expect(row(page, line)).toHaveCount(0);
});

test("a failed step with no identifiable error line says so, and offers its last line and full output; boundaries stay labelled approximate", async ({ page }) => {
  const lines = NODE_ACTION_JOB.map((l, i) => (i >= 16 && i <= 28 ? l.replace(/Z .*/, `Z publishing notes, part ${i}`) : l));
  await mockGitHub(page, lines, NODE_ACTION_STEPS);
  await openJob(page);
  await expect(page.getByRole("group", { name: "Quick filters" }).locator('[data-filter="errors"] .lchip-count')).toHaveText("0");
  const none = page.getByTestId("no-evidence");
  await expect(none).toContainText("No error line was identified in this step's lines");
  await expect(page.getByTestId("step-grouping")).toContainText("the step boundaries are approximate");
  await expect(page.locator('[data-testid=log-step][data-step="3"]')).toContainText("≈ lines 13–29");
  await none.getByRole("link", { name: /Go to the step's last line \(29\)/ }).click();
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "29");
  await none.getByRole("button", { name: "Show all of this step's lines" }).click();
  for (const line of [14, 15, 16]) await expect(row(page, line)).toBeAttached();
});

test("selected-step scope: counts, filters and error navigation cover that step, and say so", async ({ page }) => {
  const lines = [
    ...NODE_ACTION_JOB.slice(0, 11),
    `${stamp}error: cannot lock ref 'refs/heads/main'`, // 12: a text match in the checkout step, which succeeded
    ...NODE_ACTION_JOB.slice(11),
  ];
  await mockGitHub(page, lines, NODE_ACTION_STEPS);
  await openJob(page);
  const errors = page.getByRole("group", { name: "Quick filters" }).locator('[data-filter="errors"] .lchip-count');
  await expect(errors).toHaveText("2");
  await page.getByTestId("failed-step").getByRole("link", { name: "Open this step" }).click();
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "22");
  await page.getByLabel("Scope").selectOption("step");
  await expect(page.getByTestId("count-scope")).toHaveText("Counts in step 3 (lines 14–30):");
  await expect(errors).toHaveText("1");
  await expect(page.getByTestId("error-position")).toHaveText("Error 1 of 1");
  await expect(page.locator('[data-testid=log-fold].fold-outside').first()).toContainText("outside the selected step");
  await expect(row(page, 12)).toHaveCount(0);

  await page.getByLabel("Scope").selectOption("job");
  await expect(errors).toHaveText("2");
  await expect(page.getByTestId("error-position")).toHaveText("Error 2 of 2");
  await page.getByRole("button", { name: "Previous error" }).click();
  await expect(page).toHaveURL(/\/steps\/3\/L12$/);
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "12");
  await expect(page.locator(".row.highlighted .kbadge")).toHaveText("error?");
});

test("without step data the log is not grouped by step, and the failure summary falls back to the whole log", async ({ page }) => {
  await mockGitHub(page, NODE_ACTION_JOB, null);
  await openJob(page);
  await expect(page.getByTestId("log-step")).toHaveCount(0);
  await expect(page.getByTestId("step-grouping")).toContainText("GitHub returned no step data for this job");
  await expect(page.getByTestId("log-evidence")).toContainText("Line 21");
  await expect(page.getByTestId("failure-evidence")).toContainText("Strongest error evidence in the whole log");
});

test.describe("visual review (desktop)", () => {
  test.use({ viewport: { width: 1366, height: 900 } });
  test("screenshots of the step-first failure flow", async ({ page }) => {
    // Output: review-screenshots/logs/ (git-ignored). Evidence for humans, not pixel assertions.
    await mockGitHub(page, NODE_ACTION_JOB, NODE_ACTION_STEPS);
    await openJob(page);
    const panel = page.locator(".log-panel");
    await panel.screenshot({ path: "review-screenshots/logs/06-node-failure-job-log.png" });
    await page.getByTestId("failed-step").getByRole("link", { name: "Open this step" }).click();
    await expect(page.locator(".row.highlighted")).toBeInViewport();
    await panel.screenshot({ path: "review-screenshots/logs/07-node-failure-step.png" });
    await page.getByRole("tab", { name: "Errors & warnings" }).click();
    await panel.screenshot({ path: "review-screenshots/logs/08-node-failure-errors.png" });
  });
});
