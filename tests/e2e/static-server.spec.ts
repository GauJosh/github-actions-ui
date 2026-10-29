// The production build served by the production static server (deploy/ui/server.mjs), at a host's root and under
// a path prefix: HTTP checks against tools/vite/security-headers.ts, and the app in a browser in live mode against a
// mocked api.github.com (page.route; the browser cannot resolve other hosts, playwright.config.ts). The log worker
// must load and finish a log in both layouts, with the worker CSP on its script.
//
// By default this builds the production bundle and starts the server from its entry point, twice. To check a
// container instead: GHA_UI_ROOT_URL=http://127.0.0.1:8081/ GHA_UI_SUBPATH_URL=http://127.0.0.1:8082/gha-ui/
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { checkStaticServer } from "../../deploy/ui/check-http.ts";
import { serverHeaders } from "../../deploy/ui/write-security-headers.ts";
import { APP_CSP, WORKER_CSP } from "../../tools/vite/security-headers.ts";
import { cspViolations, instrument } from "./support";

type Target = { origin: string; base: string };
const external = process.env.GHA_UI_ROOT_URL && process.env.GHA_UI_SUBPATH_URL;
const targets: Record<"root" | "subpath", Target> = { root: { origin: "", base: "/" }, subpath: { origin: "", base: "/gha-ui/" } };
const servers: ChildProcess[] = [];
let workdir = "";

const nonce = Math.random().toString(36).slice(2, 10);
const FAKE_TOKEN = `e2e-fake-token-not-real-${nonce}`;
const LOG = Buffer.from(
  Array.from({ length: 12_000 }, (_, i) => (i === 11_990 ? "2026-10-20T00:00:00.0000000Z Error: expected widget to render" : `2026-10-20T00:00:00.0000000Z static line ${i + 1}`)).join("\n") + "\n",
);

/** Starts the server from its entry point, as the image does, and waits for it to report its port. */
function serve(env: Record<string, string>): Promise<{ origin: string; process: ChildProcess }> {
  const child = spawn(process.execPath, ["deploy/ui/server.mjs"], { env: { ...process.env, PORT: "0", ...env }, stdio: ["ignore", "pipe", "inherit"] });
  servers.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString();
      const port = / on port (\d+)/.exec(out)?.[1];
      if (port) resolve({ origin: `http://127.0.0.1:${port}`, process: child });
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (external) {
    for (const [key, url] of [["root", process.env.GHA_UI_ROOT_URL!], ["subpath", process.env.GHA_UI_SUBPATH_URL!]] as const) {
      const u = new URL(url);
      targets[key] = { origin: u.origin, base: u.pathname };
    }
    return;
  }
  workdir = mkdtempSync(join(tmpdir(), "gha-ui-static-e2e-"));
  const saved = process.env.GHA_UI_FIXTURES;
  delete process.env.GHA_UI_FIXTURES;
  try {
    await build({ configFile: "vite.config.ts", logLevel: "silent", build: { outDir: join(workdir, "dist"), emptyOutDir: true } });
  } finally {
    if (saved !== undefined) process.env.GHA_UI_FIXTURES = saved;
  }
  writeFileSync(join(workdir, "headers.json"), JSON.stringify(serverHeaders()));
  const env = { GHA_UI_STATIC_ROOT: join(workdir, "dist"), GHA_UI_HEADERS_FILE: join(workdir, "headers.json") };
  targets.root.origin = (await serve({ ...env, GHA_UI_BASE_PATH: "/" })).origin;
  targets.subpath.origin = (await serve({ ...env, GHA_UI_BASE_PATH: "/gha-ui/" })).origin;
});

test.afterAll(() => {
  for (const s of servers) s.kill();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

type Seen = { method: string; host: string; path: string; authorization?: string };

async function mockGitHub(page: Page, origin: string): Promise<Seen[]> {
  const seen: Seen[] = [];
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, accept, range, x-github-api-version",
    "access-control-expose-headers": "Link, Content-Length, Content-Range, x-ratelimit-remaining, x-ratelimit-reset",
  };
  // Anything else on a GitHub or log host is recorded and refused.
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com|blob\.core\.windows\.net)\//, (route) => {
    const u = new URL(route.request().url());
    seen.push({ method: route.request().method(), host: u.host, path: u.pathname });
    return route.abort();
  });
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const h = request.headers();
    const path = new URL(request.url()).pathname;
    seen.push({ method: request.method(), host: "api.github.com", path, authorization: h["authorization"] });
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

for (const layout of ["root", "subpath"] as const) {
  test(`static server (${layout}): headers match tools/vite/security-headers.ts; no fallback, fixtures or traversal`, async () => {
    const t = targets[layout];
    expect(await checkStaticServer(t.origin, t.base)).toEqual([]);
  });

  test(`static server (${layout}): the app runs in live mode, the log worker loads and finishes a log, hash routes work`, async ({ page }) => {
    const t = targets[layout];
    const home = `${t.origin}${t.base}`;
    await instrument(page);
    const seen = await mockGitHub(page, t.origin);
    const csp = new Map<string, string | undefined>();
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.origin === t.origin) csp.set(u.pathname, r.headers()["content-security-policy"]);
    });

    await page.goto(home);
    await page.getByTestId("token-input").fill(FAKE_TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByLabel("GitHub Actions run URL").fill("https://github.com/acme/app/actions/runs/1");
    await page.getByRole("button", { name: "Open run" }).click();
    await expect(page).toHaveURL(`${home}#/runs/acme/app/1`);
    await page.getByTestId("job-list").getByRole("button", { name: /test/ }).click();
    await page.getByTestId("open-log").click();
    await expect(page).toHaveURL(`${home}#/runs/acme/app/1/jobs/2/log`);
    const status = page.getByTestId("log-status");
    await expect(status).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
    await expect(status).toContainText(`Download complete (${LOG.length.toLocaleString("en-US")} bytes, matches the size reported by GitHub)`);
    // The worker processed the log: search runs inside it.
    await page.getByLabel("Search log").fill("expected widget");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("search-summary")).toHaveText("1 matching lines");

    // The worker script came from this layout's assets/, with the worker CSP; the page and assets with the app CSP.
    const worker = page.workers().find((w) => /log-worker-/.test(w.url()));
    expect(worker).toBeDefined();
    const workerPath = new URL(worker!.url()).pathname;
    expect(workerPath).toMatch(new RegExp(`^${t.base}assets/log-worker-[\\w-]+\\.js$`));
    expect(csp.get(workerPath)).toBe(WORKER_CSP);
    expect(csp.get(t.base)).toBe(APP_CSP);
    const assets = [...csp.keys()].filter((p) => p !== workerPath && p.startsWith(`${t.base}assets/`));
    expect(assets.length).toBeGreaterThan(0);
    for (const p of assets) expect(csp.get(p), p).toBe(APP_CSP);
    expect([...csp.keys()].every((p) => p.startsWith(t.base))).toBe(true);
    expect(await worker!.evaluate(() => fetch("/").then(() => "allowed", () => "blocked"))).toBe("blocked");
    expect(await cspViolations(page)).toEqual([]);

    // GitHub is called directly by the browser, read-only, with the token only on the API host; nothing persisted.
    const app = seen.filter((s) => s.method !== "OPTIONS");
    expect(app.length).toBeGreaterThan(0);
    expect(app.every((s) => s.host === "api.github.com" && (s.method === "GET" || s.method === "HEAD"))).toBe(true);
    expect(app.every((s) => s.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length, cookies: document.cookie }));
    expect(storage).toEqual({ local: 0, session: 0, idb: 0, cookies: "" });
    expect(page.url()).not.toContain(FAKE_TOKEN);

    // A deep link opened in a new tab loads the same page (the route is in the hash, never sent to the server) and,
    // with no token in that tab, asks for one while keeping the route.
    const fresh = await page.context().newPage();
    await fresh.goto(`${home}#/runs/acme/app/1/jobs/2/log`);
    await expect(fresh.getByTestId("token-input")).toBeVisible();
    expect(fresh.url()).toBe(`${home}#/runs/acme/app/1/jobs/2/log`);
    await fresh.close();
  });

  test(`static server (${layout}): ?mode=fixtures is unavailable and makes no request`, async ({ page }) => {
    const t = targets[layout];
    const seen = await mockGitHub(page, t.origin);
    const local: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.includes("__fixtures")) local.push(r.url());
    });
    await page.goto(`${t.origin}${t.base}?mode=fixtures`);
    await expect(page.getByRole("alert")).toContainText("Fixture mode is not available in this build. No request was made.");
    await page.getByRole("link", { name: "Continue to GitHub sign-in" }).click();
    await expect(page.getByTestId("token-input")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(t.base);
    expect(local).toEqual([]);
    expect(seen).toEqual([]);
  });
}

test("static server: the HTTP checks fail when the served worker CSP differs from the source", async () => {
  test.skip(!!external, "control case for the locally started server only");
  const stale = join(workdir, "stale-headers.json");
  writeFileSync(stale, JSON.stringify({ ...serverHeaders(), worker: "default-src 'none'; script-src 'self'" }));
  const s = await serve({ GHA_UI_STATIC_ROOT: join(workdir, "dist"), GHA_UI_HEADERS_FILE: stale, GHA_UI_BASE_PATH: "/" });
  const failures = await checkStaticServer(s.origin, "/");
  expect(failures.length).toBe(1);
  expect(failures[0]).toMatch(/^log-worker-[\w-]+\.js: Content-Security-Policy is /);
});
