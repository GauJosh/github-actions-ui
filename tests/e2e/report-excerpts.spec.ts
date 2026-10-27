// User-selected log excerpts in the investigation report (fixture mode, SYNTHETIC runs and logs only; the
// credential-shaped values below are made up). Lines are read from the log already loaded, never fetched again.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { InvestigationReport } from "../../src/domain/report/report";
import { forbidGitHub } from "./support";

const runUrl = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
// 990000127's "build" job: steps Set up job, Checkout, Compile (3), Complete job.
const JOB = 99000012701;
const LOG_PATH = `/__fixtures/api/repos/fixtures/synthetic/actions/jobs/${JOB}/logs`;
const SECRET = "synthetic-not-a-secret";
const BEARER = "synthetictoken12345";

/**
 * Serves the job's fixture log with lines added inside step 3 (after "working on Compile…"): two credential-shaped
 * lines, a plain line, a 2,100-character line and 205 filler lines. Returns the 1-based number of the first one.
 */
async function serveLog(page: Page): Promise<number> {
  const original = (await (await page.request.get(LOG_PATH)).text()).split("\n");
  const at = original.findIndex((l) => l.includes("working on Compile"));
  const ts = original[at]!.split(" ")[0];
  const added = [`${ts} compile: using password=${SECRET}`, `${ts} auth header Bearer ${BEARER}`, `${ts} plain synthetic line`, `${ts} ${"y".repeat(2100)}`, ...Array.from({ length: 205 }, (_, i) => `${ts} filler ${i}`)];
  const log = Buffer.from([...original.slice(0, at + 1), ...added, ...original.slice(at + 1)].join("\n"));
  await page.route(new RegExp(`/actions/jobs/${JOB}/logs$`), (route) => {
    const request = route.request();
    if (request.method() === "HEAD") return route.fulfill({ status: 200, headers: { "content-length": String(log.length), "accept-ranges": "bytes" }, body: "" });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers()["range"] ?? "");
    if (!range) return route.fulfill({ status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: log });
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : log.length - 1, log.length - 1);
    return route.fulfill({ status: 206, headers: { "content-type": "text/plain; charset=utf-8", "content-range": `bytes ${start}-${end}/${log.length}` }, body: log.subarray(start, end + 1) });
  });
  return at + 2;
}

async function select(page: Page, from: number, to: number) {
  await page.getByTestId("excerpt-from").fill(String(from));
  await page.getByTestId("excerpt-to").fill(String(to));
  await page.getByTestId("add-excerpt").click();
}

function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
}

test("excerpts: only the selected lines, one step, masked, previewed exactly, removable, exported without new requests", async ({ page }) => {
  const github = await forbidGitHub(page);
  const L = await serveLog(page);
  await page.goto(runUrl(990000127, `/jobs/${JOB}/steps/3/log`));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("step-range")).toContainText(/lines \d+–\d+/i);
  const range = /lines (\d+)–(\d+)/i.exec((await page.getByTestId("step-range").textContent()) ?? "")!;
  const [stepStart, stepEnd] = [Number(range[1]), Number(range[2])];
  expect(stepStart).toBeLessThan(L);

  const requests = recordRequests(page);
  // The step's whole range is the default: over 200 lines, so it is refused, not cut.
  await expect(page.getByTestId("excerpt-from")).toHaveValue(String(stepStart));
  await expect(page.getByTestId("excerpt-to")).toHaveValue(String(stepEnd));
  await page.getByTestId("add-excerpt").click();
  await expect(page.getByTestId("excerpt-problem")).toContainText(`The selection has ${stepEnd - stepStart + 1} lines; an excerpt can hold at most 200. Shorten it.`);
  await expect(page.getByTestId("export-report")).toHaveText("Export report");
  // Across a step boundary: refused.
  await select(page, stepStart - 1, stepStart);
  await expect(page.getByTestId("excerpt-problem")).toContainText("crosses a step boundary");

  await select(page, L, L + 2);
  await expect(page.getByTestId("excerpt-added")).toHaveText(`Lines ${L}–${L + 2} added to the report.`);
  await expect(page.getByTestId("export-report")).toHaveText("Export report (1 log excerpt)");
  // A line over 2,000 characters: the exact cut is shown and must be accepted.
  await select(page, L + 3, L + 3);
  await expect(page.getByTestId("excerpt-long-lines")).toContainText(`Line ${L + 3} is longer than 2,000 characters. The report keeps the first 2,000 characters`);
  await expect(page.getByTestId("export-report")).toHaveText("Export report (1 log excerpt)");
  await page.getByTestId("add-excerpt-cut").click();
  await select(page, L + 2, L + 2);
  await expect(page.getByTestId("export-report")).toHaveText("Export report (3 log excerpts)");

  await page.getByTestId("export-report").click();
  const excerpts = page.getByTestId("export-excerpt");
  await expect(excerpts).toHaveCount(3);
  await expect(page.locator('[data-testid="report-section"][data-section="logExcerpts"]')).toHaveAttribute("data-state", "partial");
  await expect(page.getByTestId("excerpt-warning")).toContainText("review every excerpt before sharing. Masking finds credential-shaped text by pattern; it cannot detect every secret.");
  const first = excerpts.nth(0);
  await expect(first).toHaveAttribute("data-step", "3");
  await expect(first).toHaveAttribute("data-start", String(L));
  await expect(first).toHaveAttribute("data-end", String(L + 2));
  await expect(first).toHaveAttribute("data-masked", "2");
  await expect(first).toContainText(`build (job ${JOB}) · step 3 (Compile) · lines ${L}–${L + 2} · 2 masked values`);
  await expect(first.locator("mark.masked")).toHaveCount(2);
  await expect(page.getByTestId("export-preview")).not.toContainText(SECRET);
  await expect(page.getByTestId("export-preview")).not.toContainText(BEARER);
  await expect(excerpts.nth(1)).toContainText("shortened to the report's limits");

  // Remove the third; the file holds exactly the two left, with the text the preview shows.
  await excerpts.nth(2).getByTestId("remove-excerpt").click();
  await expect(excerpts).toHaveCount(2);
  await expect(page.getByTestId("export-report")).toHaveText("Export report (2 log excerpts)");
  const shown = await Promise.all([0, 1].map((i) => excerpts.nth(i).getByTestId("excerpt-line").allTextContents()));
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-report").click()]);
  expect(file.suggestedFilename()).toBe("report-fixtures-synthetic-990000127-attempt1.json");
  const text = readFileSync((await file.path())!, "utf8");
  const report = JSON.parse(text) as InvestigationReport;
  expect(report.repository).toMatchObject({ owner: "fixtures", repo: "synthetic" });
  expect(report.run).toMatchObject({ id: 990000127, viewedAttempt: 1, latestAttempt: 1 });
  expect(report.privacy.excerpts).toBe(2);
  const out = report.logExcerpts.data!.excerpts;
  expect(out.map(({ jobId, job, step, startLine, endLine, masked, truncated }) => ({ jobId, job, step, startLine, endLine, masked, truncated }))).toEqual([
    { jobId: JOB, job: "build", step: 3, startLine: L, endLine: L + 2, masked: 2, truncated: false },
    { jobId: JOB, job: "build", step: 3, startLine: L + 3, endLine: L + 3, masked: 0, truncated: true },
  ]);
  expect(out.map((e) => e.lines)).toEqual(shown);
  expect(out[0]!.lines[0]).toMatch(/compile: using password=\[masked\]$/);
  expect(out[0]!.lines[1]).toMatch(/auth header Bearer \[masked\]$/);
  // The whole line (timestamp included) is cut at exactly 2,000 characters, followed by "…".
  expect(out[1]!.lines[0]).toHaveLength(2001);
  expect(out[1]!.lines[0]!.endsWith("y…")).toBe(true);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(BEARER);
  expect(text).not.toContain("filler");
  expect(text).not.toContain("working on Compile");

  // Adding, previewing and exporting read only the log already held: no request at all.
  expect(requests).toEqual([]);
  expect(github).toEqual([]);
});

test("excerpts: at most 10, the eleventh refused; zero excerpts still export", async ({ page }) => {
  await forbidGitHub(page);
  await page.goto(runUrl(990000127, `/jobs/${JOB}/log`));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  for (let i = 1; i <= 10; i++) {
    await select(page, 1, 1);
    await expect(page.getByTestId("export-report")).toHaveText(`Export report (${i} log excerpt${i === 1 ? "" : "s"})`);
  }
  await select(page, 2, 2);
  await expect(page.getByTestId("excerpt-problem")).toContainText("The report already holds 10 excerpts, the most it can; remove one first.");
  await page.getByTestId("export-report").click();
  await expect(page.getByTestId("export-excerpt")).toHaveCount(10);
  // The runner's preamble (line 1) is part of step 1, "Set up job", in the step mapping.
  await expect(page.getByTestId("export-excerpt").first()).toHaveAttribute("data-step", "1");
  for (let i = 0; i < 10; i++) await page.getByTestId("remove-excerpt").first().click();
  await expect(page.locator('[data-testid="report-section"][data-section="logExcerpts"]')).toHaveAttribute("data-state", "not applicable");
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-report").click()]);
  const report = JSON.parse(readFileSync((await file.path())!, "utf8")) as InvestigationReport;
  expect(report.logExcerpts).toEqual({ state: "not applicable", reason: expect.stringContaining("No log excerpts were included") });
});

test("excerpts: changing attempt or run discards them; they never reach another report", async ({ page }) => {
  await forbidGitHub(page);
  // 990000124 is at attempt 2; its latest build job is 99000012401 (attempt 1's jobs have no fixture logs).
  await page.goto(runUrl(990000124, "/jobs/99000012401/log"));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await select(page, 1, 2);
  await expect(page.getByTestId("export-report")).toHaveText("Export report (1 log excerpt)");

  // Attempt 1 of the same run (same page, only the URL changes).
  await page.goto(runUrl(990000124, "?attempt=1"));
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 2");
  await expect(page.getByTestId("export-report")).toHaveText("Export report");
  await page.getByTestId("export-report").click();
  await expect(page.getByTestId("export-identity")).toHaveAttribute("data-attempt", "1");
  await expect(page.locator('[data-testid="report-section"][data-section="logExcerpts"]')).toHaveAttribute("data-state", "not applicable");
  await expect(page.getByTestId("export-excerpt")).toHaveCount(0);
  // Back on attempt 2: discarded, not restored.
  await page.goto(runUrl(990000124, "/jobs/99000012401/log"));
  await expect(page.getByTestId("attempt-banner")).toHaveCount(0);
  await expect(page.getByTestId("export-report")).toHaveText("Export report");

  // Another run.
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await select(page, 1, 1);
  await expect(page.getByTestId("export-report")).toHaveText("Export report (1 log excerpt)");
  await page.goto(runUrl(990000126));
  await expect(page.getByTestId("export-report")).toHaveText("Export report");
  await page.getByTestId("export-report").click();
  await expect(page.getByTestId("export-identity")).toHaveAttribute("data-run", "990000126");
  await expect(page.getByTestId("export-excerpt")).toHaveCount(0);
});

const row = (page: Page, n: number) => page.locator(`.row[data-line="${n}"]`);
async function setBoundary(page: Page, n: number, which: "first" | "last") {
  await row(page, n).getByTestId("line-menu").click();
  await page.getByTestId(which === "first" ? "set-first-line" : "set-last-line").click();
}

test("line menu: boundaries set from log rows fill the form, can be adjusted, and add the intended excerpt; no request", async ({ page }) => {
  const github = await forbidGitHub(page);
  const L = await serveLog(page);
  await page.goto(runUrl(990000127, `/jobs/${JOB}/steps/3/log`));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("step-range")).toContainText(/lines \d+–\d+/i);
  const requests = recordRequests(page);

  await setBoundary(page, L, "first");
  // Focus returns to that line's menu button, so reading continues from the line.
  await expect(row(page, L).getByTestId("line-menu")).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await setBoundary(page, L + 2, "last");
  await expect(page.getByTestId("excerpt-from")).toHaveValue(String(L));
  await expect(page.getByTestId("excerpt-to")).toHaveValue(String(L + 2));
  await expect(page.getByTestId("excerpt-range")).toHaveText(`Selected: lines ${L}–${L + 2} (3 lines), shaded in the log.`);
  for (const n of [L, L + 1, L + 2]) await expect(row(page, n)).toHaveClass(/in-excerpt/);
  await expect(row(page, L + 3)).not.toHaveClass(/in-excerpt/);

  // Adjust either boundary by typing; the shading follows.
  await page.getByTestId("excerpt-to").fill(String(L + 1));
  await expect(page.getByTestId("excerpt-range")).toHaveText(`Selected: lines ${L}–${L + 1} (2 lines), shaded in the log.`);
  await expect(row(page, L + 2)).not.toHaveClass(/in-excerpt/);
  await page.getByTestId("add-excerpt").click();
  await expect(page.getByTestId("excerpt-added")).toHaveText(`Lines ${L}–${L + 1} added to the report.`);
  await page.getByTestId("export-report").click();
  const excerpt = page.getByTestId("export-excerpt");
  await expect(excerpt).toHaveCount(1);
  await expect(excerpt).toHaveAttribute("data-start", String(L));
  await expect(excerpt).toHaveAttribute("data-end", String(L + 1));
  await expect(excerpt).toHaveAttribute("data-step", "3");
  await expect(excerpt.getByTestId("excerpt-line")).toHaveCount(2);
  await expect(excerpt.locator("mark.masked")).toHaveCount(2);

  expect(requests).toEqual([]);
  expect(github).toEqual([]);
});

test("line menu: a reversed range is explained, never swapped, and cannot be added; step and size rules still apply", async ({ page }) => {
  await forbidGitHub(page);
  const L = await serveLog(page);
  await page.goto(runUrl(990000127, `/jobs/${JOB}/steps/3/log`));
  await expect(page.getByTestId("step-range")).toContainText(/lines \d+–\d+/i);
  const stepStart = Number(/lines (\d+)–/i.exec((await page.getByTestId("step-range").textContent()) ?? "")![1]);

  await setBoundary(page, L + 2, "first");
  await setBoundary(page, L, "last");
  await expect(page.getByTestId("excerpt-range")).toHaveAttribute("data-state", "invalid");
  await expect(page.getByTestId("excerpt-range")).toHaveText(`The first line (${L + 2}) is after the last line (${L}). Change one of them; they are not swapped.`);
  await expect(page.getByTestId("excerpt-from")).toHaveValue(String(L + 2));
  await expect(page.getByTestId("excerpt-to")).toHaveValue(String(L));
  await expect(page.getByTestId("add-excerpt")).toBeDisabled();
  await expect(page.getByTestId("export-report")).toHaveText("Export report");

  // Across a step boundary: refused. (The line before the step is in a collapsed step, so it is typed.)
  await page.getByTestId("excerpt-from").fill(String(stepStart - 1));
  await expect(page.getByTestId("excerpt-range")).toHaveAttribute("data-state", "valid");
  await page.getByTestId("add-excerpt").click();
  await expect(page.getByTestId("excerpt-problem")).toContainText("crosses a step boundary");
  // Over 200 lines: refused, not cut.
  await setBoundary(page, L, "first");
  await page.getByTestId("excerpt-to").fill(String(L + 205));
  await expect(page.getByTestId("excerpt-problem")).toHaveCount(0);
  await page.getByTestId("add-excerpt").click();
  await expect(page.getByTestId("excerpt-problem")).toContainText("The selection has 206 lines; an excerpt can hold at most 200. Shorten it.");
  // A line over 2,000 characters still needs explicit confirmation.
  await setBoundary(page, L + 3, "first");
  await page.getByTestId("excerpt-to").fill(String(L + 3));
  await page.getByTestId("add-excerpt").click();
  await expect(page.getByTestId("excerpt-long-lines")).toContainText(`Line ${L + 3} is longer than 2,000 characters`);
  await expect(page.getByTestId("export-report")).toHaveText("Export report");
});

test("line menu: keyboard only, open, move, choose, close; focus returns to the line", async ({ page }) => {
  await forbidGitHub(page);
  await page.goto(runUrl(990000127, `/jobs/${JOB}/log`));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  const button = row(page, 4).getByTestId("line-menu");
  await expect(button).toHaveAccessibleName("Line 4: report excerpt actions");
  await expect(button).toHaveAttribute("aria-haspopup", "menu");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menuitem", { name: "Set as first line" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Set as last line" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(page.getByTestId("excerpt-to")).toHaveValue("1");

  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("excerpt-to")).toHaveValue("4");
  await expect(button).toBeFocused();
  await row(page, 3).getByTestId("line-menu").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("excerpt-from")).toHaveValue("3");
  await expect(page.getByTestId("excerpt-range")).toHaveText("Selected: lines 3–4 (2 lines), shaded in the log.");
  // The form stays fully usable by keyboard.
  await page.getByTestId("add-excerpt").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("excerpt-added")).toHaveText("Lines 3–4 added to the report.");
});

test("line menu: a boundary set in one run or attempt is not carried into another", async ({ page }) => {
  await forbidGitHub(page);
  await page.goto(runUrl(990000124, "/jobs/99000012401/log"));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await setBoundary(page, 3, "first");
  await setBoundary(page, 4, "last");
  await expect(page.getByTestId("excerpt-range")).toHaveText("Selected: lines 3–4 (2 lines), shaded in the log.");

  // Attempt 1 of the same run, then back: the boundaries are gone.
  await page.goto(runUrl(990000124, "?attempt=1"));
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 2");
  await expect(page.getByTestId("excerpt-picker")).toHaveCount(0);
  await page.goto(runUrl(990000124, "/jobs/99000012401/log"));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("excerpt-from")).toHaveValue("1");
  await expect(page.getByTestId("excerpt-to")).toHaveValue("1");
  await expect(page.locator(".row.in-excerpt")).toHaveCount(1);

  // Another run's job log starts from its own defaults.
  await setBoundary(page, 4, "last");
  await page.goto(runUrl(990000127, `/jobs/${JOB}/log`));
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("excerpt-to")).toHaveValue("1");
});
