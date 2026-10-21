// Live mode against a mocked api.github.com (page.route). No real GitHub request is made: the browser
// cannot resolve non-local hosts (playwright.config.ts), and the token is a fake value generated per run.
//
// Limitation: Playwright does not route the request that follows a redirect it fulfilled itself, so here
// the mocked API serves the log directly. The API → log-host redirect (token dropped, host-only diagnostics,
// signed-URL marker never surfaced) is covered by src/logs/download/redirect.test.ts and by experiment E9.
import { expect, test, type Page } from "@playwright/test";
import { APP_CSP } from "../../tools/vite/security-headers.ts";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { FIXTURE_COMMIT, cspViolations, instrument } from "./support";

const ORIGIN = "http://127.0.0.1:4317";
const nonce = Math.random().toString(36).slice(2, 10);
const FAKE_TOKEN = `e2e-fake-token-not-real-${nonce}`;
const LOG = Buffer.from(
  Array.from({ length: 12_000 }, (_, i) =>
    i === 11_990 ? "2026-10-20T00:00:00.0000000Z Error: expected widget to render" : `2026-10-20T00:00:00.0000000Z live line ${i + 1}`,
  ).join("\n") + "\n",
);

type Seen = { method: string; path: string; authorization?: string; range?: string };

async function mockGitHub(page: Page): Promise<Seen[]> {
  const seen: Seen[] = [];
  const cors = {
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-headers": "authorization, accept, range, x-github-api-version",
    "access-control-expose-headers": "Link, Content-Length, Content-Range, x-ratelimit-remaining, x-ratelimit-reset",
  };
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const h = request.headers();
    const path = new URL(request.url()).pathname;
    seen.push({ method: request.method(), path, authorization: h["authorization"], range: h["range"] });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET, HEAD" } });
    if (path === "/repos/acme/app/actions/runs/1") {
      return route.fulfill({
        json: { id: 1, display_title: "CI on main", status: "completed", conclusion: "failure", run_attempt: 1, head_branch: "main", head_sha: "a".repeat(40), html_url: "https://github.com/acme/app/actions/runs/1", event: "push", path: ".github/workflows/ci.yml" },
        headers: cors,
      });
    }
    if (path === "/repos/acme/app/actions/runs/1/jobs") {
      return route.fulfill({
        json: {
          total_count: 1,
          jobs: [
            {
              id: 2,
              name: "test",
              status: "completed",
              conclusion: "failure",
              started_at: null,
              completed_at: null,
              html_url: "https://github.com/acme/app/actions/runs/1/job/2",
              steps: [{ number: 3, name: "Run tests", status: "completed", conclusion: "failure", started_at: null, completed_at: null }],
            },
          ],
        },
        headers: cors,
      });
    }
    if (path === "/repos/acme/app/contents/.github/workflows/ci.yml") {
      const ref = new URL(request.url()).searchParams.get("ref");
      if (ref !== "a".repeat(40)) return route.fulfill({ status: 404, json: { message: "Not Found" }, headers: cors });
      return route.fulfill({ json: { type: "file", encoding: "base64", content: Buffer.from("jobs:\n  test:\n    runs-on: x\n").toString("base64") }, headers: cors });
    }
    if (path === "/repos/acme/app/actions/jobs/2/logs") {
      const range = /^bytes=(\d+)-(\d+)$/.exec(h["range"] ?? "");
      if (request.method() === "HEAD") return route.fulfill({ status: 200, headers: { ...cors, "content-length": String(LOG.length) }, body: "" });
      if (!range) return route.fulfill({ status: 200, headers: cors, body: LOG });
      const [start, end] = [Number(range[1]), Math.min(Number(range[2]), LOG.length - 1)];
      return route.fulfill({ status: 206, headers: { ...cors, "content-range": `bytes ${start}-${end}/${LOG.length}` }, body: LOG.subarray(start, end + 1) });
    }
    return route.fulfill({ status: 404, json: { message: "Not Found" }, headers: cors });
  });
  return seen;
}

async function connectAndOpen(page: Page) {
  await page.goto("/");
  await page.getByTestId("token-input").fill(FAKE_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByLabel("GitHub Actions run URL").fill("https://github.com/acme/app/actions/runs/1");
  await page.getByRole("button", { name: "Open run" }).click();
}

test("live mode: the token stays in memory, is sent only to the API, and is never exposed; requests are read-only", async ({ page }) => {
  const consoleText: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  await instrument(page);
  const seen = await mockGitHub(page);
  await connectAndOpen(page);

  await expect(page.getByTestId("job-list")).toContainText("test");
  await page.getByTestId("job-list").getByRole("button", { name: /test/ }).click();
  await expect(page.getByTestId("failure-summary")).toHaveText("GitHub's step data identifies the failed step: Run tests.");
  await page.getByTestId("open-log").click();
  const status = page.getByTestId("log-status");
  await expect(status).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  await expect(status).toContainText(`Download complete (${LOG.length.toLocaleString("en-US")} bytes, matches the size reported by GitHub)`);

  const app = seen.filter((s) => s.method !== "OPTIONS");
  // Read-only: only GET and HEAD (OPTIONS preflights are generated by the browser, not the app).
  expect(app.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
  expect(app.every((s) => s.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  expect(app.map((s) => s.range).filter(Boolean)).toEqual([`bytes=${LOG.length - 262144}-${LOG.length - 1}`, `bytes=0-${LOG.length - 262145}`]);
  // The graph's workflow file was requested at the run's own commit, not a branch.
  expect(app.some((s) => s.path === "/repos/acme/app/contents/.github/workflows/ci.yml")).toBe(true);

  // Nothing persisted, nothing in the URL, nothing surfaced.
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    idb: (await indexedDB.databases()).length,
    cookies: document.cookie,
  }));
  expect(storage).toEqual({ local: 0, session: 0, idb: 0, cookies: "" });
  expect(page.url()).not.toContain(FAKE_TOKEN);
  await page.locator("details.diagnostics summary").click();
  await expect(page.getByTestId("diag-events")).toContainText("api.github.com");
  const pageText = await page.locator("body").innerText();
  expect(pageText).not.toContain(FAKE_TOKEN);
  expect(consoleText.join("\n")).not.toContain(FAKE_TOKEN);
  expect(await cspViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("token-input")).toBeVisible();
  await expect(page.getByTestId("token-input")).toHaveValue("");
});

test("live mode: an API failure is an explicit state", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      status: 401,
      json: { message: "Bad credentials" },
      headers: { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "authorization, accept, x-github-api-version" },
    }),
  );
  await connectAndOpen(page);
  await expect(page.getByRole("alert")).toContainText("GitHub rejected the token (invalid or expired)");
});

test("CSP is enforced: a host removed from connect-src is blocked", async ({ page }) => {
  await instrument(page);
  await mockGitHub(page);
  // Serve the app document with api.github.com removed from its policy.
  await page.route(`${ORIGIN}/`, async (route) => {
    const response = await route.fetch();
    const narrowed = APP_CSP.replace(" https://api.github.com", "");
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": narrowed } });
  });
  await connectAndOpen(page);
  await expect(page.getByRole("alert")).toContainText("Network error");
  expect((await cspViolations(page)).some((v) => v.startsWith("connect-src"))).toBe(true);
});

test("live dashboard: a token that cannot list repositories, rate limits, and a failed next page are explicit states", async ({ page }) => {
  const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "authorization, accept, x-github-api-version", "access-control-expose-headers": "Link, x-ratelimit-remaining, x-ratelimit-reset" };
  let runPages = 0;
  await page.route("https://api.github.com/**", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET, HEAD" } });
    if (url.pathname === "/user/repos") return route.fulfill({ status: 403, json: { message: "Resource not accessible by personal access token" }, headers: cors });
    if (url.pathname === "/repos/acme/limited/actions/runs") {
      return route.fulfill({ status: 403, json: { message: "API rate limit exceeded" }, headers: { ...cors, "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } });
    }
    if (url.pathname === "/repos/acme/app/actions/runs") {
      runPages++;
      if (url.searchParams.get("page") === "2") return route.fulfill({ status: 502, json: { message: "Bad gateway" }, headers: cors });
      const runs = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, display_title: `run ${i + 1}`, status: "completed", conclusion: "success", run_attempt: 1, head_branch: "main", head_sha: "b".repeat(40), html_url: "https://github.com/acme/app", event: "push" }));
      return route.fulfill({ json: { total_count: 40, workflow_runs: runs }, headers: { ...cors, link: '<https://api.github.com/repos/acme/app/actions/runs?per_page=25&page=2>; rel="next"' } });
    }
    if (url.pathname.endsWith("/actions/workflows")) return route.fulfill({ json: { total_count: 0, workflows: [] }, headers: cors });
    return route.fulfill({ status: 404, json: { message: "Not Found" }, headers: cors });
  });
  await page.goto("/");
  await page.getByTestId("token-input").fill(FAKE_TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toContainText("This token cannot list repositories");

  await page.getByLabel("Repository (owner/repo)").fill("acme/limited");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("GitHub rate limit reached. It resets at");

  // Same page, same in-memory session: only the fragment changes.
  await page.evaluate(() => (window.location.hash = "#/repos/acme/app"));
  await expect(page.getByTestId("run-list").locator("li")).toHaveCount(25);
  await page.getByRole("button", { name: "Load 25 more" }).click();
  await expect(page.getByRole("alert")).toContainText("Showing partial results: the next page could not be loaded.");
  await expect(page.getByTestId("run-list").locator("li")).toHaveCount(25);
  expect(runPages).toBeGreaterThanOrEqual(2);
});

test("live mode, no step markers in the log: the step gets a clear fallback and no lines are attributed to it", async ({ page }) => {
  await mockGitHub(page);
  await connectAndOpen(page);
  await page.getByTestId("job-list").getByRole("button", { name: /test/ }).click();
  await page.getByTestId("failed-step-link").click();
  await expect(page).toHaveURL(/#\/runs\/acme\/app\/1\/jobs\/2\/steps\/3$/);
  await expect(page.getByTestId("log-status")).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  const locator = page.getByTestId("step-locator");
  await expect(locator).toHaveAttribute("data-state", "unmatched");
  await expect(locator).toContainText("No log marker was found for step 3.");
  await expect(page.locator(".row.in-step")).toHaveCount(0);
  await expect(page.locator(".row.highlighted")).toHaveCount(0);
  await page.getByTestId("find-errors").click();
  await expect(page.getByLabel("Search log")).toHaveValue("##[error]");
  await expect(page.getByTestId("search-summary")).toHaveText("No matches");
});

test("live mode, a real runner log (fixture s16 served by the mocked API): the failed step after a composite action is found", async ({ page }) => {
  const seen = await mockGitHub(page);
  const dir = `.fixtures/${FIXTURE_COMMIT}/fixtures/GauJosh__gha-ui-fixtures/39370654036`;
  const s16 = JSON.parse(readFileSync(`${dir}/attempts/1/jobs.json`, "utf8")) as { jobs: { id: number }[] };
  const job = { ...s16.jobs[0]!, id: 2, html_url: "https://github.com/acme/app/actions/runs/1/job/2" };
  const log = gunzipSync(readFileSync(`${dir}/logs/${s16.jobs[0]!.id}.log.gz`));
  const cors = { "access-control-allow-origin": ORIGIN, "access-control-expose-headers": "Content-Length, Content-Range" };
  // Registered after mockGitHub, so these take precedence for the jobs list and the log.
  await page.route("https://api.github.com/repos/acme/app/actions/runs/1/jobs*", (route) =>
    route.request().method() === "OPTIONS" ? route.fallback() : route.fulfill({ json: { total_count: 1, jobs: [job] }, headers: cors }),
  );
  await page.route("https://api.github.com/repos/acme/app/actions/jobs/2/logs", (route) => {
    const request = route.request();
    seen.push({ method: request.method(), path: "/repos/acme/app/actions/jobs/2/logs", range: request.headers()["range"] });
    if (request.method() === "OPTIONS") return route.fallback();
    if (request.method() === "HEAD") return route.fulfill({ status: 200, headers: { ...cors, "content-length": String(log.length) }, body: "" });
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers()["range"] ?? "");
    if (!range) return route.fulfill({ status: 200, headers: cors, body: log });
    const [start, end] = [Number(range[1]), Math.min(Number(range[2]), log.length - 1)];
    return route.fulfill({ status: 206, headers: { ...cors, "content-range": `bytes ${start}-${end}/${log.length}` }, body: log.subarray(start, end + 1) });
  });
  await connectAndOpen(page);
  await page.getByTestId("job-list").getByRole("button", { name: /composite-then-step/ }).click();
  await page.getByTestId("failed-step-link").click();
  await expect(page).toHaveURL(/#\/runs\/acme\/app\/1\/jobs\/2\/steps\/4$/);
  const locator = page.getByTestId("step-locator");
  await expect(locator).toHaveAttribute("data-state", "found");
  await expect(locator).toContainText("Step 4: Step after composite");
  const highlighted = page.locator(".row.highlighted");
  await expect(highlighted).toContainText("##[error]synthetic failure in the step after the composite action");
  await expect(highlighted).toBeInViewport();
  // The composite action's inner output is not attributed to the failed step.
  await expect(page.locator(".row.step-start")).toContainText('##[group]Run echo "running the step that follows the composite action"');
  const compositeOutput = page.locator(".row").filter({ hasText: /config ok$/ });
  await expect(compositeOutput).toHaveCount(1);
  await expect(compositeOutput).not.toHaveClass(/in-step/);
  expect(seen.filter((s) => s.method !== "OPTIONS").every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
  expect(page.url()).not.toContain("token");
});

test("live mode, nested reusable workflow the token cannot read: explicit reason, no synthetic data, read-only", async ({ page }) => {
  const seen = await mockGitHub(page);
  const cors = { "access-control-allow-origin": ORIGIN, "access-control-expose-headers": "Content-Length" };
  const shared = "c".repeat(40);
  const caller = "jobs:\n  ci:\n    uses: org/shared/.github/workflows/ci.yml@main\n";
  // Registered after mockGitHub, so these take precedence: the run reports the resolved commit; the file is forbidden.
  await page.route("https://api.github.com/repos/acme/app/actions/runs/1", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fallback()
      : route.fulfill({
          json: { id: 1, display_title: "CI on main", status: "completed", conclusion: "failure", run_attempt: 1, head_branch: "main", head_sha: "a".repeat(40), html_url: "https://github.com/acme/app/actions/runs/1", event: "push", path: ".github/workflows/ci.yml", referenced_workflows: [{ path: "org/shared/.github/workflows/ci.yml@main", sha: shared, ref: "refs/heads/main" }] },
          headers: cors,
        }),
  );
  await page.route("https://api.github.com/repos/acme/app/contents/.github/workflows/ci.yml*", (route) =>
    route.request().method() === "OPTIONS" ? route.fallback() : route.fulfill({ json: { type: "file", encoding: "base64", content: Buffer.from(caller).toString("base64") }, headers: cors }),
  );
  await page.route("https://api.github.com/repos/org/shared/contents/**", (route) => {
    seen.push({ method: route.request().method(), path: new URL(route.request().url()).pathname + new URL(route.request().url()).search });
    return route.request().method() === "OPTIONS" ? route.fallback() : route.fulfill({ status: 403, json: { message: "Resource not accessible by personal access token" }, headers: cors });
  });
  await connectAndOpen(page);
  await expect(page.getByTestId("graph-viewport")).toBeVisible();
  await expect(page.getByText(/The token cannot read org\/shared\/\.github\/workflows\/ci\.yml/).first()).toBeVisible();
  // The called file was requested at the commit GitHub reported, never at the branch name.
  const sharedReads = seen.filter((s) => s.path.startsWith("/repos/org/shared/") && s.method !== "OPTIONS");
  expect(sharedReads.map((s) => s.path)).toEqual([`/repos/org/shared/contents/.github/workflows/ci.yml?ref=${shared}`]);
  expect(seen.filter((s) => s.method !== "OPTIONS").every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
  await expect(page.locator("body")).not.toContainText("[synthetic]");
});
