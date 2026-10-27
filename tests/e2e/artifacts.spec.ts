// GitHub artifacts of a run (fixture mode, SYNTHETIC artifacts only): loaded on request, metadata only, confirmed for
// the run only by the artifact's own metadata, never tied to an attempt, GET-only and never downloaded.
import { expect, test } from "@playwright/test";
import { forbidGitHub } from "./support";

const synthetic = (id: number, rest = "") => `/?mode=fixtures#/runs/fixtures/synthetic/${id}${rest}`;
const isArtifacts = (url: string) => /\/artifacts(\?|\/|$)/.test(new URL(url).pathname + new URL(url).search);

test("artifacts: nothing requested until asked; confirmed, expired and run-not-named records; GET only, no download", async ({ page }) => {
  const github = await forbidGitHub(page);
  const methods = new Set<string>();
  const requests: string[] = [];
  page.on("request", (r) => {
    methods.add(r.method());
    if (isArtifacts(r.url())) requests.push(new URL(r.url()).pathname + new URL(r.url()).search);
  });
  // 990000127 (one attempt) lists 104 synthetic artifacts over two pages (see syntheticArtifacts in the fixture server).
  await page.goto(synthetic(990000127));
  const section = page.getByTestId("run-artifacts");
  await expect(section.getByTestId("load-artifacts")).toBeVisible();
  await expect(section.getByTestId("artifacts-listing")).toHaveAttribute("data-state", "not loaded");
  await page.waitForTimeout(300);
  expect(requests).toEqual([]);

  await section.getByTestId("load-artifacts").click();
  await expect(section.getByTestId("artifact")).toHaveCount(104);
  expect(requests).toEqual(["/__fixtures/api/repos/fixtures/synthetic/actions/runs/990000127/artifacts?per_page=100", "/__fixtures/api/repos/fixtures/synthetic/actions/runs/990000127/artifacts?per_page=100&page=2"]);
  const listing = section.getByTestId("artifacts-listing");
  await expect(listing).toHaveAttribute("data-state", "complete");
  await expect(listing).toHaveText("Complete listing · 104 artifacts");
  await expect(listing).toHaveAttribute("data-attempt", "single attempt when checked");
  await expect(section.getByTestId("artifacts-note").first()).toHaveText("The run had a single attempt when checked.");

  const row = (id: number) => section.locator(`[data-testid="artifact"][data-id="${id}"]`);
  await expect(row(9930001)).toHaveAttribute("data-association", "confirmed");
  await expect(row(9930001)).toContainText("[synthetic] build-output");
  await expect(row(9930001)).toContainText("Confirmed for this run");
  await expect(row(9930001)).toContainText("The artifact's metadata names this run and its commit.");
  await expect(row(9930001).getByTestId("artifact-digest")).toContainText("digest sha256:");
  await expect(row(9930001).getByTestId("artifact-expiry")).toContainText("Not expired");

  await expect(row(9930002)).toHaveAttribute("data-expired", "true");
  await expect(row(9930002).getByTestId("artifact-expiry")).toContainText("Expired · metadata only");
  await expect(row(9930002).getByTestId("artifact-expiry")).toContainText("expired 2026-10-20 05:00:00 UTC");
  await expect(row(9930002).getByTestId("artifact-digest")).toHaveCount(0);

  await expect(row(9930003)).toHaveAttribute("data-association", "unknown");
  await expect(row(9930003)).toContainText("Run not named in its metadata");
  await expect(row(9930003)).toContainText("does not confirm the run itself");

  const notes = await section.getByTestId("artifacts-note").allTextContents();
  expect(notes).toContain("1 expired artifact is shown as metadata only; it can no longer be downloaded.");
  expect(notes).toContain("GitHub does not link artifacts to deployments or releases; artifacts are listed for the run only.");
  // Nothing claims an attempt, a release or a deployment for any artifact.
  const text = (await section.textContent()) ?? "";
  expect(text).not.toMatch(/from attempt|uploaded by attempt|was released|was deployed|used by/i);
  // No link or request to a download URL.
  await expect(section.locator("a")).toHaveCount(0);
  expect(requests.some((r) => /\/zip|\/artifacts\/\d+/.test(r))).toBe(false);
  expect([...methods].every((m) => m === "GET" || m === "HEAD")).toBe(true);
  expect(github).toEqual([]);
});

test("artifacts of a re-run, viewing an earlier attempt: whole-run wording, never a single attempt", async ({ page }) => {
  await forbidGitHub(page);
  // 990000124 is at attempt 2; attempt 1's own data reports run_attempt 1, which must not decide the wording.
  await page.goto(synthetic(990000124, "?attempt=1"));
  await expect(page.getByTestId("attempt-banner")).toContainText("Viewing attempt 1 of 2");
  const section = page.getByTestId("run-artifacts");
  await section.getByTestId("load-artifacts").click();
  await expect(section.getByTestId("artifact")).toHaveCount(1);
  await expect(section.getByTestId("artifact")).toHaveAttribute("data-association", "confirmed");
  await expect(section.getByTestId("artifacts-listing")).toHaveAttribute("data-attempt", "whole run");
  const notes = await section.getByTestId("artifacts-note").allTextContents();
  expect(notes.slice(0, 2)).toEqual([
    "Artifacts are listed for the whole run; GitHub does not say which attempt uploaded each one.",
    "You are viewing attempt 1 of 2; these artifacts are not shown as belonging to it.",
  ]);
  await expect(section).not.toContainText("single attempt");

  // The latest attempt of the same re-run: the listing (per run) stays loaded, its wording follows the attempt on
  // screen, and it is still the whole run.
  await page.goto(synthetic(990000124));
  await expect(page.getByTestId("attempt-banner")).toHaveCount(0);
  await expect(page.getByTestId("run-artifacts").getByTestId("load-artifacts")).toHaveCount(0);
  await expect(page.getByTestId("run-artifacts").getByTestId("artifacts-listing")).toHaveAttribute("data-attempt", "whole run");
  await expect(page.getByTestId("run-artifacts")).toContainText("The run has 2 attempts; none of these artifacts is shown as belonging to a particular one.");
  await expect(page.getByTestId("run-artifacts")).not.toContainText("single attempt");
});

test("artifacts: an empty listing is not 'never uploaded'; a failed listing shows an error and Try again", async ({ page }) => {
  await forbidGitHub(page);
  await page.goto(synthetic(990000126));
  const section = page.getByTestId("run-artifacts");
  await section.getByTestId("load-artifacts").click();
  await expect(section.getByTestId("artifacts-listing")).toHaveAttribute("data-state", "none listed");
  await expect(section).toContainText("GitHub lists no artifacts for this run now. That does not mean none was uploaded: artifacts expire and can be deleted.");
  await expect(section.getByTestId("artifact")).toHaveCount(0);

  // A run still in progress (990000134) may upload more artifacts, and is not qualified as a single attempt.
  await page.goto(synthetic(990000134));
  await page.getByTestId("run-artifacts").getByTestId("load-artifacts").click();
  await expect(page.getByTestId("run-artifacts")).toContainText("The run has not completed, so more artifacts may still be uploaded.");
  await expect(page.getByTestId("run-artifacts").getByTestId("artifacts-listing")).toHaveAttribute("data-attempt", "whole run");

  // Page two fails once: page one is not shown as the listing; Try again loads both pages.
  let fail = true;
  await page.route(/\/actions\/runs\/990000127\/artifacts\?per_page=100&page=2$/, (route) => (fail ? ((fail = false), route.fulfill({ status: 503, json: { message: "synthetic outage" } })) : route.fallback()));
  await page.goto(synthetic(990000127));
  const other = page.getByTestId("run-artifacts");
  await other.getByTestId("load-artifacts").click();
  await expect(other.getByTestId("artifacts-listing")).toHaveAttribute("data-state", "unavailable");
  await expect(other.getByRole("alert")).toContainText("Try again");
  await expect(other.getByTestId("artifact")).toHaveCount(0);
  // Deployments and releases are not affected by the artifact failure.
  await expect(page.getByTestId("load-deployments")).toBeVisible();
  await expect(page.getByTestId("load-releases")).toBeVisible();
  await other.getByRole("button", { name: "Try again" }).click();
  await expect(other.getByTestId("artifact")).toHaveCount(104);
  await expect(other.getByTestId("artifacts-listing")).toHaveAttribute("data-state", "complete");
});

test("artifacts: leaving the run while a page loads requests no further page and shows nothing stale", async ({ page }) => {
  await forbidGitHub(page);
  const started: string[] = [];
  const held: (() => void)[] = [];
  await page.route(/\/actions\/runs\/990000127\/artifacts/, async (route) => {
    started.push(route.request().url());
    await new Promise<void>((resolve) => held.push(resolve));
    await route.fallback();
  });
  await page.goto(synthetic(990000127));
  await page.getByTestId("load-artifacts").click();
  await expect.poll(() => started.length).toBe(1);
  await page.goto(synthetic(990000126));
  await expect(page.getByTestId("run-artifacts")).toContainText("GitHub artifacts of this run");
  for (const release of held.splice(0)) release();
  await page.waitForTimeout(300);
  // Page two of the run that was left was never requested, and none of its artifacts appear here.
  expect(started).toHaveLength(1);
  await expect(page.getByTestId("artifact")).toHaveCount(0);
  await expect(page.getByTestId("load-artifacts")).toBeVisible();
  await expect(page.getByTestId("artifacts-listing")).toHaveAttribute("data-state", "not loaded");
});
