// Log display modes, filters and search (docs/ARCHITECTURE.md §8.1), in live mode against a mocked api.github.com
// serving SYNTHETIC logs. No real GitHub request is made; the token is a fake value generated per run.
import { expect, test, type Page } from "@playwright/test";
import { SAMPLE, cyan } from "../../tools/fixture-server/noisy-log.ts";

const ORIGIN = "http://127.0.0.1:4317";
const FAKE_TOKEN = `e2e-fake-token-not-real-${Math.random().toString(36).slice(2, 10)}`;
const stamp = "2026-10-20T04:40:00.0000000Z ";
const STEPS = ["Set up job", "Run actions/checkout@v4", "Run ./.github/actions/deploy-config", "Run npm test", "Post Run actions/checkout@v4", "Complete job"];

type Served = { methods: string[]; bodyRequests: number };

/** Serves one failed job whose log is `log`. `breakBody`: the body download stops halfway and then keeps failing. */
async function mockGitHub(page: Page, log: Buffer, opts: { breakBody?: boolean } = {}): Promise<Served> {
  const served: Served = { methods: [], bodyRequests: 0 };
  const cors = {
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-headers": "authorization, accept, range, x-github-api-version",
    "access-control-expose-headers": "Link, Content-Length, Content-Range, x-ratelimit-remaining, x-ratelimit-reset",
  };
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    served.methods.push(request.method());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET, HEAD" } });
    if (path === "/repos/acme/app/actions/runs/1") {
      return route.fulfill({
        json: { id: 1, display_title: "CI on main", status: "completed", conclusion: "failure", run_attempt: 1, head_branch: "main", head_sha: "a".repeat(40), html_url: "https://github.com/acme/app/actions/runs/1", event: "push", path: ".github/workflows/ci.yml" },
        headers: cors,
      });
    }
    if (path === "/repos/acme/app/actions/runs/1/jobs") {
      const steps = STEPS.map((name, i) => ({ number: i + 1, name, status: "completed", conclusion: i === 3 ? "failure" : "success", started_at: null, completed_at: null }));
      return route.fulfill({
        json: { total_count: 1, jobs: [{ id: 2, name: "build", status: "completed", conclusion: "failure", started_at: null, completed_at: null, html_url: "https://github.com/acme/app/actions/runs/1/job/2", steps }] },
        headers: cors,
      });
    }
    if (path === "/repos/acme/app/actions/jobs/2/logs") {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers()["range"] ?? "");
      if (request.method() === "HEAD") return route.fulfill({ status: 200, headers: { ...cors, "content-length": String(log.length) }, body: "" });
      if (!range) return route.fulfill({ status: 200, headers: cors, body: log });
      const [start, end] = [Number(range[1]), Math.min(Number(range[2]), log.length - 1)];
      const isBody = start === 0 || served.bodyRequests > 0;
      if (opts.breakBody && isBody && end < log.length - 1) {
        served.bodyRequests++;
        if (served.bodyRequests > 1) return route.fulfill({ status: 500, json: { message: "Server Error" }, headers: cors });
        // Half the requested bytes, then the connection "ends".
        const half = start + Math.floor((end - start) / 2);
        return route.fulfill({ status: 206, headers: { ...cors, "content-range": `bytes ${start}-${end}/${log.length}` }, body: log.subarray(start, half) });
      }
      return route.fulfill({ status: 206, headers: { ...cors, "content-range": `bytes ${start}-${end}/${log.length}` }, body: log.subarray(start, end + 1) });
    }
    return route.fulfill({ status: 404, json: { message: "Not Found" }, headers: cors });
  });
  return served;
}

async function openFailedStep(page: Page) {
  await page.goto("/");
  await page.getByTestId("token-input").fill(FAKE_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("GitHub Actions run URL").fill("https://github.com/acme/app/actions/runs/1");
  await page.getByRole("button", { name: "Open run" }).click();
  await page.getByTestId("job-list").getByRole("button", { name: /build/ }).click();
  await page.getByTestId("failed-step-link").click();
  await expect(page).toHaveURL(/#\/runs\/acme\/app\/1\/jobs\/2\/steps\/4$/);
}

const sampleLog = () => Buffer.from(SAMPLE.join("\n") + "\n");
const row = (page: Page, line: number) => page.locator(`.row[data-line="${line}"]`);

test("Essential output by default: noise folded into labelled rows, meaningful lines visible, every line recoverable", async ({ page }) => {
  const served = await mockGitHub(page, sampleLog());
  await openFailedStep(page);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByRole("tab", { name: "Essential output" })).toHaveAttribute("aria-selected", "true");

  // The failed step opens at its runner error annotation, highlighted.
  const highlighted = page.locator(".row.highlighted");
  await expect(highlighted).toHaveAttribute("data-line", "53");
  await expect(highlighted.locator(".kbadge")).toHaveText("error");

  // Folded: setup preamble and groups, the step echo, control markers, repeats. Visible: headers, action output, results.
  const setup = page.locator('[data-testid=log-fold][data-start="1"]');
  await expect(setup).toContainText("14 lines folded · runner setup · 2 groups: “Runner Image Provisioner”, “GITHUB_TOKEN Permissions”");
  await expect(page.locator('[data-testid=log-fold][data-start="39"]')).toContainText("step script and settings echoed by the runner");
  await expect(page.locator('[data-testid=log-fold][data-start="34"]')).toContainText("3 lines folded · repeated identical lines");
  for (const [line, text] of [
    [15, "##[group]Run actions/checkout@v4"],
    [32, "Resolved configuration for dev: 3 services, 2 feature flags"],
    [38, "##[group]Run npm test"],
    [47, "FAIL src/b.test.ts"],
    [57, "an unrecognised line that must stay visible"],
  ] as const) {
    await expect(row(page, line)).toContainText(text);
  }
  await expect(row(page, 5)).toHaveCount(0); // ##[endgroup]
  await expect(page.getByTestId("log-view-summary")).toContainText("Unrecognised lines are never folded.");

  // Expanding a fold restores exactly its original lines and numbers.
  await setup.getByRole("button").click();
  await expect(row(page, 1)).toContainText("Current runner version: '2.337.0'");
  await expect(row(page, 5)).toContainText("##[endgroup]");
  await expect(row(page, 14)).toContainText("Complete job name: build");
  await page.getByRole("button", { name: /Fold expanded lines again/ }).click();
  await expect(row(page, 1)).toHaveCount(0);

  // All output: every line, unchanged; the step, line and highlight are kept.
  await page.getByRole("tab", { name: "All output" }).click();
  await expect(page.locator("[data-testid=log-fold]")).toHaveCount(0);
  // The view stays on the selected line; the top of the log is a scroll away (rows are virtualised).
  await expect(highlighted).toHaveAttribute("data-line", "53");
  await expect(highlighted).toBeInViewport();
  await page.getByTestId("log-view").evaluate((el) => (el.scrollTop = 0));
  await expect(row(page, 5)).toContainText("##[endgroup]");
  await expect(row(page, 18)).toContainText("token: ***");
  await expect(page).toHaveURL(/\/jobs\/2\/steps\/4$/);
  await expect(page.getByTestId("step-locator")).toHaveAttribute("data-state", /found|approximate/);
  expect(served.methods.every((m) => m === "GET" || m === "HEAD" || m === "OPTIONS")).toBe(true);
});

test("Errors & warnings: annotations versus text matches, step header as evidence, configurable context", async ({ page }) => {
  await mockGitHub(page, sampleLog());
  await openFailedStep(page);
  await page.getByRole("tab", { name: "Errors & warnings" }).click();
  await page.getByLabel("Context lines").selectOption("0");
  const shown = page.locator(".row[data-line]");
  await expect(shown).toHaveCount(7);
  await expect.poll(() => shown.evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-line"))))).toEqual([38, 47, 48, 49, 51, 52, 53]);
  await expect(row(page, 53).locator(".kbadge")).toHaveText("error");
  await expect(row(page, 52).locator(".kbadge")).toHaveText("warning");
  await expect(row(page, 49).locator(".kbadge")).toHaveText("error?");
  await expect(row(page, 49).locator(".kbadge")).toHaveAttribute("title", /does not show that a command or the job failed/);
  await expect(row(page, 51).locator(".kbadge")).toHaveText("warning?");
  // Familiar words without a pattern match are not errors.
  await expect(row(page, 50)).toHaveCount(0);
  await expect(page.getByTestId("log-view-summary")).toContainText("Errors & warnings: 1 error and 1 warning annotations, 4 lines that look like errors, warnings or test failures");

  await page.getByLabel("Context lines").selectOption("1");
  await expect(row(page, 50)).toContainText("error handling module loaded");
  await expect(row(page, 54)).toContainText("Post job cleanup.");
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "53");
});

test("failure investigation: reveal around the error, unfold the step, switch modes, keeping the step selected", async ({ page }) => {
  await mockGitHub(page, sampleLog());
  await openFailedStep(page);
  const actions = page.getByTestId("step-actions");
  await expect(row(page, 39)).toHaveCount(0); // the step's script echo is folded
  await actions.getByRole("button", { name: "Show 20 lines around line 53" }).click();
  await expect(row(page, 39)).toContainText("npm test");
  await expect(row(page, 44)).toContainText("##[endgroup]");
  await page.getByRole("button", { name: /Fold expanded lines again/ }).click();
  await actions.getByRole("button", { name: "Unfold this step's lines" }).click();
  await expect(row(page, 41)).toContainText("shell: /usr/bin/bash -e {0}");
  await actions.getByRole("button", { name: "Errors & warnings" }).click();
  await expect(page.getByRole("tab", { name: "Errors & warnings" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", "53");
  await expect(page.getByTestId("job-details").locator('.step[aria-current="step"]')).toContainText("Run npm test");
});

test("quick filters combine and show counts; unknown lines have their own filter", async ({ page }) => {
  await mockGitHub(page, sampleLog());
  await openFailedStep(page);
  const filters = page.getByRole("group", { name: "Quick filters" });
  await expect(filters.locator('[data-filter="commands"] .lchip-count')).toHaveText("7");
  await expect(filters.locator('[data-filter="unclassified"] .lchip-count')).toHaveText("3");
  await page.getByLabel("Context lines").selectOption("0");
  await filters.locator('[data-filter="commands"]').click();
  await filters.locator('[data-filter="tests"]').click();
  const lines = page.locator(".row[data-line]");
  await expect.poll(() => lines.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-kind")))).toEqual(expect.arrayContaining(["command", "script", "test", "test-failed"]));
  for (const kind of await lines.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-kind")))) expect(["command", "script", "test", "test-failed", "error"]).toContain(kind);
  await expect(page.locator('[data-testid=log-fold].fold-gap').first()).toContainText("not shown");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await filters.locator('[data-filter="unclassified"]').click();
  await expect.poll(() => lines.evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-line"))).filter((n) => n !== 53))).toEqual([45, 50, 57]);
});

test("search: case, whole word, regular expressions (invalid ones are safe), count, next/previous, step scope, matching lines only", async ({ page }) => {
  await mockGitHub(page, sampleLog());
  await openFailedStep(page);
  const box = page.getByLabel("Search log");
  const summary = page.getByTestId("search-summary");
  await box.fill("error");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(summary).toHaveText("3 matching lines");
  // The step's error line is itself a match, so the search stays there; next wraps to the first match.
  await expect(page.getByTestId("search-position")).toHaveText("3 of 3");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page).toHaveURL(/\/steps\/4\/L49$/);
  await expect(row(page, 49).locator("mark")).toHaveText("Error");
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page).toHaveURL(/\/steps\/4\/L50$/);
  await page.getByRole("button", { name: "Previous match" }).click();
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(page).toHaveURL(/\/steps\/4\/L53$/);
  await expect(page.getByTestId("search-position")).toHaveText("3 of 3");

  await page.getByRole("button", { name: "Match case" }).click();
  await expect(summary).toHaveText("2 matching lines"); // "error handling…" and "##[error]", not "Error:"

  await page.getByRole("button", { name: "Match case" }).click();
  await box.fill("errors");
  await page.getByRole("button", { name: "Whole word" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(summary).toHaveText("1 matching lines");
  await page.getByRole("button", { name: "Whole word" }).click();

  await page.getByRole("button", { name: "Regular expression" }).click();
  await box.fill("(unclosed");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("search-error")).toContainText("Invalid regular expression");
  await expect(page.getByTestId("log-view")).toBeVisible();
  await box.fill("(PASS|FAIL) src/");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(summary).toHaveText("2 matching lines");
  await page.getByRole("button", { name: "Regular expression" }).click();

  // Within the selected step only.
  await box.fill("git");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(summary).toHaveText(/^[1-9]\d* matching lines$/); // checkout and its cleanup, outside the npm test step
  await page.getByLabel("Search in").selectOption("step");
  await expect(summary).toHaveText("No matches");

  // Only matching lines, with context.
  await page.getByLabel("Search in").selectOption("job");
  await box.fill("503");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Context lines").selectOption("1");
  await page.getByLabel("Only matching lines").check();
  await expect.poll(() => page.locator(".row[data-line]").evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-line"))))).toEqual([48, 49, 50]);
});

test("partially loaded log: modes, filters and search work on the loaded lines, say so, and offer an explicit retry", async ({ page }) => {
  const lines = [...SAMPLE.slice(0, 38), ...Array.from({ length: 30_000 }, (_, i) => `${stamp}compile unit ${i + 1}: ok`), ...SAMPLE.slice(38)];
  const served = await mockGitHub(page, Buffer.from(lines.join("\n") + "\n"), { breakBody: true });
  await openFailedStep(page);
  const status = page.getByTestId("log-status");
  await expect(status).toHaveAttribute("data-status", "incomplete", { timeout: 30_000 });
  await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();
  const before = served.bodyRequests;

  await page.getByRole("tab", { name: "Essential output" }).click();
  await expect(page.locator('[data-testid=log-fold][data-start="1"]')).toContainText("runner setup");
  await expect(page.getByTestId("log-view-summary")).toContainText("lines loaded so far");
  await page.getByLabel("Search log").fill("compile unit 1000:");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("search-summary")).toHaveText("1 matching lines in the bytes loaded so far");
  await page.getByRole("group", { name: "Quick filters" }).locator('[data-filter="commands"]').click();
  await expect(page.locator(".row.k-command").first()).toContainText("Run actions/checkout@v4");
  // Nothing above triggered another download.
  expect(served.bodyRequests).toBe(before);
});

test("large log with many collapsed sections: folded, navigable, and every line still reachable", async ({ page }) => {
  const lines = [...SAMPLE.slice(0, 37), `${stamp}##[group]Run make sections`, `${stamp}${cyan("make sections")}`, `${stamp}##[endgroup]`];
  for (let s = 1; s <= 20_000; s++) lines.push(`${stamp}##[group]Section ${s}`, `${stamp}section ${s} detail a`, `${stamp}section ${s} detail b`, `${stamp}##[endgroup]`, `${stamp}section ${s} result`);
  lines.push(`${stamp}##[error]Process completed with exit code 2.`, `${stamp}Cleaning up orphan processes`);
  await mockGitHub(page, Buffer.from(lines.join("\n") + "\n"));
  await openFailedStep(page);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete", { timeout: 60_000 });
  await expect(page.getByTestId("log-view-summary")).toContainText(/Essential output: [\d,]+ of 100,042 lines shown; [\d,]+ folded into [\d,]+ expandable rows/);
  const fold = page.locator("[data-testid=log-fold]").filter({ hasText: "group “Section 1”" });
  await page.getByLabel("Search log").fill("section 19999 detail b");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("search-summary")).toHaveText("1 matching lines");
  // The match is inside a folded group: it is revealed and highlighted at its original line number.
  const target = page.locator(".row.highlighted");
  await expect(target).toContainText("section 19999 detail b");
  await expect(target).toBeInViewport();
  const n = Number(await target.getAttribute("data-line"));
  expect(lines[n - 1]).toContain("section 19999 detail b");
  await expect(fold).toHaveCount(0); // far away, not rendered (virtualised)
  await page.getByRole("tab", { name: "All output" }).click();
  await expect(page.getByTestId("log-view-summary")).toContainText("All output: every line, unchanged.");
  await expect(page.locator(".row.highlighted")).toHaveAttribute("data-line", String(n));
});
