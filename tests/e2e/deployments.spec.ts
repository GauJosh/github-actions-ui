// GitHub deployments of a run's commit (fixture mode, SYNTHETIC deployments only): loaded on request, each tied to the
// run only as far as GitHub's data shows, status failures kept apart from empty statuses, GET-only requests.
import { expect, test } from "@playwright/test";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
const isDeployments = (url: string) => /\/deployments(\?|\/)/.test(url);

test("deployments of a run's commit: confirmed by a status link, same commit only, unknown status, and nothing loaded until asked", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = new Set<string>();
  const requests: string[] = [];
  page.on("request", (r) => {
    methods.add(r.method());
    if (isDeployments(r.url())) requests.push(new URL(r.url()).pathname + new URL(r.url()).search);
  });
  // 990000127's commit has five synthetic deployments (see syntheticDeployments in the fixture server).
  await page.goto(synthetic(990000127));
  const section = page.getByTestId("run-deployments");
  await expect(section.getByTestId("load-deployments")).toBeVisible();
  expect(requests).toEqual([]);

  await section.getByTestId("load-deployments").click();
  const rows = section.getByTestId("deployment");
  await expect(rows).toHaveCount(5);
  const row = (id: number) => section.locator(`[data-testid="deployment"][data-id="${id}"]`);
  // A status links to this run, and the commit matches.
  await expect(row(9910001)).toHaveAttribute("data-association", "confirmed");
  await expect(row(9910001)).toHaveAttribute("data-outcome", "succeeded");
  await expect(row(9910001)).toContainText("Confirmed for this run");
  await expect(row(9910001)).toContainText("synthetic-env-a");
  // Same commit, but its status links to another run.
  await expect(row(9910002)).toHaveAttribute("data-association", "same commit");
  await expect(row(9910002)).toContainText("links to run 990000126");
  // Its statuses could not be loaded: unknown, not "no status".
  await expect(row(9910003)).toHaveAttribute("data-outcome", "statuses not loaded");
  await expect(row(9910003)).toContainText("status could not be loaded");
  await expect(row(9910003)).toHaveAttribute("data-association", "same commit");
  await expect(row(9910003)).toContainText("its statuses could not be read, so whether they link to this run is unknown");
  // GitHub reported no status at all.
  await expect(row(9910004)).toHaveAttribute("data-outcome", "no status");
  await expect(row(9910004)).toContainText("no status reported");
  // Links outside GitHub or not URLs at all do not tie it to a run; the latest status decides the outcome.
  await expect(row(9910005)).toHaveAttribute("data-association", "same commit");
  await expect(row(9910005)).toHaveAttribute("data-outcome", "failed");

  await expect(section.getByTestId("deployments-failed")).toContainText("The statuses of 1 deployment could not be loaded (#9910003)");
  await expect(section.getByTestId("deployments-scope")).toContainText("this is not the repository's deployment history");
  const notes = section.getByTestId("deployments-note");
  await expect(notes).toContainText(["2 deployments of this commit to synthetic-env-b; each is listed with its own status.", "2 deployments of this commit to synthetic-env-c; each is listed with its own status.", "Some deployments' statuses were not loaded or could not be read; their outcome is unknown."]);

  expect(requests.filter((r) => /\/deployments\?sha=[0-9a-f]{40}&per_page=100$/.test(r))).toHaveLength(1);
  expect(requests.filter((r) => /\/deployments\/\d+\/statuses\?per_page=100$/.test(r)).sort()).toEqual(
    [9910001, 9910002, 9910003, 9910004, 9910005].map((id) => `/__fixtures/api/repos/fixtures/synthetic/deployments/${id}/statuses?per_page=100`),
  );
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("deployments joined to this run's job environments: a job only when a status names it, otherwise the run or a candidate", async ({ page }) => {
  await forbidGitHub(page);
  // 990000102 (CD): deploy-dev uses dev, deploy-staging staging, deploy-prod's three matrix jobs production.
  await page.goto(synthetic(990000102, "?view=graph"));
  await page.getByTestId("load-deployments").click();
  const section = page.getByTestId("run-deployments");
  await expect(section.getByTestId("deployment")).toHaveCount(5);
  const join = (id: number) => section.locator(`[data-testid="deployment"][data-id="${id}"] [data-testid="deployment-job-env"]`);
  await expect(join(9910201)).toHaveAttribute("data-match", "job linked");
  await expect(join(9910201)).toHaveText("Job deploy-dev · dev: its status names this job");
  // Linked to the run, but no job named.
  await expect(join(9910202)).toHaveAttribute("data-match", "run confirmed");
  await expect(join(9910202)).toHaveText("This run's staging jobs: which one created it is not named");
  // Two deployments to production of the same commit: one names a matrix job, the other has no status at all.
  await expect(join(9910203)).toHaveText("Job deploy-prod (eu-west) · production: its status names this job");
  await expect(join(9910204)).toHaveAttribute("data-match", "candidate");
  await expect(join(9910204)).toHaveText("Candidate for this run's production jobs: same environment and commit only");
  // No job of this run uses that environment.
  await expect(join(9910205)).toHaveAttribute("data-match", "none");
  await expect(join(9910205)).toHaveText("No job-environment record of this run (declared or from an input) names synthetic-preview.");
  await expect(section.getByTestId("deployments-env-missing")).toHaveCount(0);
});

test("releases of a run's commit: loaded only when asked, confirmed by the resolved tag, the rest counted, and never called deployed", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = new Set<string>();
  const requests: string[] = [];
  page.on("request", (r) => {
    methods.add(r.method());
    const u = new URL(r.url());
    if (/\/(releases|git\/ref\/tags|git\/tags)(\/|\?|$)/.test(u.pathname)) requests.push(u.pathname + u.search);
  });
  await page.goto(synthetic(990000127));
  const releases = page.getByTestId("run-releases");
  await expect(releases.getByTestId("load-releases")).toBeVisible();
  expect(requests).toEqual([]);

  await releases.getByTestId("load-releases").click();
  const confirmed = releases.getByTestId("release-confirmed");
  await expect(confirmed).toHaveCount(2);
  // A lightweight tag and a nested annotated tag (prerelease), both resolved to this commit.
  const v140 = releases.locator('[data-testid="release-confirmed"][data-id="9920002"]');
  await expect(v140).toContainText("v1.4.0");
  await expect(v140).toContainText("[synthetic] v1.4.0");
  await expect(v140).toContainText("Its lightweight tag points to the run's commit.");
  await expect(v140).toContainText("this run did not necessarily create or publish it");
  await expect(v140.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", "https://github.com/fixtures/synthetic/releases/tag/v1.4.0");
  const rc = releases.locator('[data-testid="release-confirmed"][data-id="9920003"]');
  await expect(rc).toContainText("Its annotated tag points to the run's commit.");
  await expect(rc.locator(".chip")).toHaveText("prerelease");
  // Deployments not loaded yet: nothing is said about them beyond that.
  await expect(v140.getByTestId("release-deployments")).toHaveText("Deployments of this commit are not loaded; load them above to compare.");

  // Other releases are counted, never listed as matches.
  const count = (kind: string) => releases.locator(`[data-testid="release-count"][data-kind="${kind}"]`);
  await expect(count("different commit")).toHaveText("6 resolve to a different commit (v1.3.0, v0.9.0, v0.8.0, v0.7.0, v0.6.0, …).");
  await expect(count("unresolved")).toHaveText("2 looked up but not resolved (v1.2.0, v1.1.0); lookup failed for v1.2.0 (http-error).");
  await expect(count("not looked up")).toHaveText("3 not looked up yet; each check looks up at most 10 (v1.5.0, v0.4.0, v0.3.0).");
  await expect(releases.getByTestId("releases-progress")).toHaveText("Tags looked up for 10 of 13 listed releases (1 page of 30 read).");
  await expect(releases.getByTestId("releases-note")).toHaveText("Releases whose tags were not resolved or not looked up are neither a match nor a mismatch with this commit.");
  await expect(releases).not.toContainText("v1.3.0 ·");

  // With the deployments loaded, a confirmed release shares their commit, explicitly not proof of deployment.
  await page.getByTestId("load-deployments").click();
  await expect(page.getByTestId("deployment")).toHaveCount(5);
  await expect(v140.getByTestId("release-deployments")).toHaveText(
    "Deployments of this commit: synthetic-env-a #9910001, synthetic-env-b #9910002, synthetic-env-b #9910003, synthetic-env-c #9910004, synthetic-env-c #9910005. Same commit; this does not establish that this release was deployed.",
  );
  await expect(releases).not.toContainText(/was deployed to|deployed by|released by this run/);

  // One listing, at most 10 tag refs, the annotated chain's two tag objects; nothing to GitHub, GET only.
  expect(requests.filter((r) => r.endsWith("/releases?per_page=30"))).toHaveLength(1);
  expect(requests.filter((r) => r.includes("/git/ref/tags/"))).toHaveLength(10);
  expect(requests.filter((r) => /\/git\/tags\/[0-9a-f]{40}$/.test(r))).toHaveLength(2);
  expect(requests.some((r) => r.includes("/git/ref/tags/v1.5.0"))).toBe(false);
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("releases: leaving the run while tags load stops further lookups and shows nothing stale; a failed listing can be retried", async ({ page }) => {
  await forbidGitHub(page);
  const started: string[] = [];
  const held: (() => void)[] = [];
  await page.route(/\/git\/ref\/tags\//, async (route) => {
    started.push(route.request().url());
    await new Promise<void>((resolve) => held.push(resolve));
    await route.fallback();
  });
  await page.goto(synthetic(990000127));
  await page.getByTestId("load-releases").click();
  await expect.poll(() => started.length).toBe(2);
  await page.goto(synthetic(990000126));
  await expect(page.getByTestId("run-releases")).toContainText("GitHub releases of commit");
  for (const release of held.splice(0)) release();
  await page.waitForTimeout(300);
  expect(started).toHaveLength(2);
  await expect(page.getByTestId("release-confirmed")).toHaveCount(0);
  await expect(page.getByTestId("load-releases")).toBeVisible();

  let fail = true;
  await page.route(/\/releases\?per_page=30$/, (route) => (fail ? ((fail = false), route.fulfill({ status: 503, json: { message: "synthetic outage" } })) : route.fallback()));
  await page.unroute(/\/git\/ref\/tags\//);
  await page.getByTestId("load-releases").click();
  await expect(page.getByTestId("run-releases").getByRole("alert")).toContainText("Try again");
  await page.getByTestId("run-releases").getByRole("button", { name: "Try again" }).click();
  // 990000126's commit: v1.3.0 resolves to it.
  await expect(page.locator('[data-testid="release-confirmed"][data-id="9920004"]')).toContainText("v1.3.0");
});

test("releases: checking the next batch keeps earlier results, looks up only what was not looked up yet, and ignores repeated clicks", async ({ page }) => {
  await forbidGitHub(page);
  const refs: string[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  await page.route(/\/git\/ref\/tags\//, async (route) => {
    refs.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/git/ref/tags/")[1]!));
    if (hold) await new Promise<void>((resolve) => held.push(resolve));
    await route.fallback();
  });
  await page.goto(synthetic(990000127));
  const releases = page.getByTestId("run-releases");
  await page.getByTestId("load-releases").click();
  await expect(releases.getByTestId("release-confirmed")).toHaveCount(2);
  expect(refs).toHaveLength(10);
  const more = releases.getByTestId("check-more-releases");
  await expect(more).toHaveText("Check the next 3 releases");

  // Second check: earlier results stay while it runs, and a second click does nothing.
  hold = true;
  await more.click();
  await expect(more).toBeDisabled();
  await more.click({ force: true });
  await expect(releases.getByTestId("releases-checking")).toBeVisible();
  await expect(releases.getByTestId("release-confirmed")).toHaveCount(2);
  await expect.poll(() => refs.length).toBe(12);
  hold = false;
  for (const release of held.splice(0)) release();
  await expect.poll(() => refs.length).toBe(13);
  await expect(releases.getByTestId("releases-checking")).toHaveCount(0);

  // Only the three not looked up yet were requested, each once.
  expect(refs.slice(10).sort()).toEqual(["v0.3.0", "v0.4.0", "v1.5.0"]);
  expect(new Set(refs).size).toBe(13);
  const count = (kind: string) => releases.locator(`[data-testid="release-count"][data-kind="${kind}"]`);
  await expect(releases.getByTestId("release-confirmed")).toHaveCount(2);
  await expect(count("different commit")).toHaveText("8 resolve to a different commit (v1.3.0, v0.9.0, v0.8.0, v0.7.0, v0.6.0, …).");
  // The draft's tag does not exist: looked up, not resolved, and still not a mismatch.
  await expect(count("unresolved")).toHaveText("3 looked up but not resolved (v1.5.0, v1.2.0, v1.1.0); lookup failed for v1.2.0 (http-error).");
  await expect(count("not looked up")).toHaveCount(0);
  await expect(releases.getByTestId("releases-progress")).toHaveText("Tags looked up for 13 of 13 listed releases (1 page of 30 read).");
  // Nothing left to check on the only page GitHub lists.
  await expect(more).toHaveCount(0);
});

test("deployments: at most two status requests at once, and leaving the run cancels the rest without filling the next run", async ({ page }) => {
  await forbidGitHub(page);
  let inflight = 0;
  let max = 0;
  const started: string[] = [];
  const held: (() => void)[] = [];
  await page.route(/\/deployments\/\d+\/statuses/, async (route) => {
    started.push(route.request().url());
    inflight++;
    max = Math.max(max, inflight);
    await new Promise<void>((resolve) => held.push(resolve));
    inflight--;
    await route.fallback();
  });
  await page.goto(synthetic(990000127));
  await page.getByTestId("load-deployments").click();
  await expect.poll(() => started.length).toBe(2);
  // Leave for another run while two status requests are held.
  await page.goto(synthetic(990000126));
  await expect(page.getByTestId("run-deployments")).toContainText("GitHub deployments of commit");
  for (const release of held.splice(0)) release();
  await page.waitForTimeout(300);
  expect(max).toBe(2);
  // No further status requests started for the run that was left, and nothing of it appears here.
  expect(started).toHaveLength(2);
  await expect(page.getByTestId("deployment")).toHaveCount(0);
  await expect(page.getByTestId("load-deployments")).toBeVisible();

  // This run's commit has no deployments: said plainly, without implying the successful run deployed anything.
  await page.getByTestId("load-deployments").click();
  await expect(page.getByTestId("deployments-note")).toHaveText("The run succeeded, but GitHub lists no deployment of its commit: a successful run is not a deployment.");
  await expect(page.getByTestId("deployments-table")).toHaveCount(0);
});
