// Emergency execution in the browser.
// - "mocked executor": always runs. Preparation is real (fixture-mode GitHub serving examples/emergency-demo); the
//   executor API is answered by page.route, which checks the uploaded snapshot's digest itself.
// - "live executor": opt-in (GHA_EMERGENCY_LIVE=1 with GHA_EMERGENCY_API_PROXY, and break-glass accounts
//   GHA_EMERGENCY_LIVE_OPERATOR and GHA_EMERGENCY_LIVE_APPROVER as "account:credential"):
//   the same flow against a real executor and Kubernetes Job (docs/EMERGENCY_EXECUTION.md, "Run the MVP locally").
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { ed25519EventSigner, judgeExecution } from "../../src/emergency/event-stream.ts";
import type { RunnerEvent } from "../../src/emergency/events.ts";
import { revalidateSnapshot } from "../../src/emergency/revalidate.ts";
import { fromBase64, manifestDigest, type Manifest, type SnapshotBundle } from "../../src/emergency/snapshot.ts";
import { forbidGitHub } from "./support";

async function prepareDemoSnapshot(page: Page) {
  await page.getByTestId("prepare-link").click();
  await page.getByTestId("prepare-repo").fill("emergency-demo/release-pipeline");
  await page.getByTestId("prepare-ref").fill("main");
  await page.getByTestId("load-workflows").click();
  await expect(page.getByTestId("resolved-commit")).toContainText(/main is commit [0-9a-f]{40}/);
  await page.getByLabel(".github/workflows/release.yml").check();
  await page.getByLabel(".github/workflows/build.yml").uncheck();
  await page.getByTestId("prepare-name").fill("release demo");
  await page.getByTestId("resolve").click();
  const prepared = page.getByTestId("prepared");
  await expect(prepared.getByTestId("validation-ok")).toBeVisible();
  // The reusable workflow and every kind of action were resolved.
  await expect(prepared.getByTestId("graph-workflow")).toHaveCount(2);
  await expect(prepared.getByTestId("manifest-actions")).toContainText("./.github/actions/stamp");
  await expect(prepared.getByTestId("manifest-actions")).toContainText("demo-org/shared-actions/notify@v1");
  await expect(prepared.getByTestId("manifest-actions")).toContainText("composite");
  await expect(prepared.getByTestId("manifest-actions")).toContainText("replaced by the packaged workspace");
  await expect(prepared.getByTestId("requirements")).toContainText("DEMO_SIGNING_KEY");
  await page.getByTestId("create-snapshot").click();
  await expect(page.getByTestId("stored")).toContainText("version");
  await page.getByTestId("stored").getByRole("link", { name: "Open the snapshot" }).click();
  await expect(page.getByTestId("snapshot-title")).toContainText("release demo");
}

type MockOptions = { bound?: boolean; network?: "enforced" | "not-enforced"; user?: MockUser };
type MockUser = { name: string; roles: string[] };
const ALICE: MockUser = { name: "alice", roles: ["operator"] };
const CAROL: MockUser = { name: "carol", roles: ["approver"] };

/** Signs in as the mock executor's current user: the button leads to the executor's auth/login, which redirects back. */
async function signIn(page: Page, hash = "#/emergency") {
  await page.goto(`/?mode=fixtures${hash}`);
  await page.getByTestId("sign-in-oidc").click();
  await expect(page.getByTestId("signed-in-user")).toBeVisible();
}

test("mocked executor: sign in, prepare, request, approve and run the demo pipeline; GitHub is never contacted", async ({ page }) => {
  const github = await forbidGitHub(page);
  const mock = await mockExecutor(page, { bound: true, network: "enforced", user: ALICE });
  await page.goto("/?mode=fixtures");
  await page.getByTestId("emergency-nav").click();
  // Security review H2: no operator token; a sign-in through the executor and the organization's identity provider.
  await expect(page.getByTestId("sign-in")).toContainText("Sign in with Example SSO");
  await page.getByTestId("sign-in-oidc").click();
  await expect(page.getByTestId("signed-in-user")).toContainText("alice");
  await expect(page.getByTestId("user-roles")).toHaveText("operator");
  await prepareDemoSnapshot(page);

  await expect(page.getByTestId("manifest-sha")).toHaveText(/^[0-9a-f]{40}$/);
  await expect(page.getByTestId("snapshot-owner")).toContainText("Prepared by alice · shared");
  // Security review H1: content integrity (the executor's) and provenance (checked here, against GitHub) are separate.
  await expect(page.getByTestId("integrity")).toContainText("Git tree verified");
  await expect(page.getByTestId("provenance-status")).toContainText("not checked — unverified");
  await page.getByTestId("check-provenance").click();
  await expect(page.getByTestId("provenance-status")).toContainText("verified");
  await expect(page.getByTestId("provenance-roots")).toContainText("the executor verified the packaged files are exactly that tree");
  // Security review C1: the Secret comes from the binding; there is nothing to type.
  await expect(page.getByTestId("secret-binding")).toContainText("from Secret demo-secrets (binding release-demo). Only these keys are mounted");
  await expect(page.getByTestId("network-verdict")).toContainText("Isolation verified by the network canary");
  // H2: it receives a Secret, so it needs an approver.
  await expect(page.getByTestId("needs-approval")).toContainText("it receives a Secret");
  await page.getByTestId("input-version").fill("9.9.9");
  await page.getByTestId("start-execution").click();
  await expect(page).toHaveURL(/#\/emergency\/executions\/00112233aabbccdd$/);
  expect(mock.execution).toEqual({ snapshotId: expect.any(String), workflow: ".github/workflows/release.yml", inputs: { version: "9.9.9" }, variables: {}, network: "isolated" });
  await expect(page.getByTestId("approval")).toContainText("Waiting for approval");
  await expect(page.getByTestId("approval-not-yours")).toContainText("another approver must decide");
  await expect(page.getByTestId("initiated-by")).toHaveText("alice");

  // carol, an approver, signs in and approves exactly the reviewed request.
  await page.getByRole("button", { name: "Sign out" }).click();
  mock.user = CAROL;
  await signIn(page, "#/emergency/executions/00112233aabbccdd");
  await page.getByTestId("approval-comment").fill("release 9.9.9, CHG-1");
  await page.getByTestId("approve").click();
  expect(mock.approval).toEqual({ decision: "approve", requestDigest: "d".repeat(64), comment: "release 9.9.9, CHG-1" });
  await expect(page.getByTestId("status-tag").first()).toHaveText("success");
  await expect(page.getByTestId("approval")).toContainText("Approved by carol");
  await expect(page.getByTestId("execution-isolation")).toContainText("NetworkPolicy enforcement verified by the canary");
  await expect(page.getByTestId("reconcile-note")).toBeVisible();
  await page.getByTestId("exec-step").first().getByRole("button").click();
  await expect(page.getByTestId("exec-log")).toContainText("Preparing emergency-demo 9.9.9");
  // Security review H3, signed by the runner's own key since H2: authenticated events, each log line labelled.
  await expect(page.getByTestId("execution-stream")).toHaveText("authenticated (11 events, complete)");
  const lines = page.getByTestId("exec-log").locator(".log-line");
  await expect(lines.nth(0)).toHaveText("runnerWorkspace restored from snapshot");
  await expect(lines.nth(2)).toHaveText("outWorkspace restored from snapshot (printed by the workflow)");

  expect(github).toEqual([]);
  // Every API call carried the CSRF header and no bearer token.
  expect(mock.requests.every((r) => r.csrf === "1" && r.authorization === undefined)).toBe(true);
});

test("security review C1/C2 in the UI: an unbound snapshot can't be started, and unproven isolation is shown and refused", async ({ page }) => {
  await forbidGitHub(page);
  const mock = await mockExecutor(page, { bound: false, network: "not-enforced", user: ALICE });
  await signIn(page);
  await prepareDemoSnapshot(page);
  await expect(page.getByTestId("not-authorized")).toContainText("Not authorized: no Secret is bound to this snapshot");
  await expect(page.getByTestId("start-execution")).toBeDisabled();
  await expect(page.getByTestId("network-verdict")).toContainText("Not verified (not-enforced)");
  await expect(page.getByTestId("network-verdict")).toContainText("Executions in this mode are refused");
  expect(mock.execution).toBeUndefined();
});

test("security review H2 in the UI: what each role sees; administrators manage others' roles; break-glass sign-in", async ({ page }) => {
  await forbidGitHub(page);
  const mock = await mockExecutor(page, { bound: true, network: "enforced", user: { name: "mallory", roles: [] } });
  // Signed in, no roles: told who they are, nothing else.
  await signIn(page);
  await expect(page.getByTestId("no-roles")).toContainText("An administrator must give you a role");
  await expect(page.getByTestId("my-subject")).toHaveText("mallory-subject");
  // A viewer: no "Prepare a snapshot", no administration.
  await page.getByRole("button", { name: "Sign out" }).click();
  mock.user = { name: "dave", roles: ["viewer"] };
  await signIn(page);
  await expect(page.getByTestId("snapshot-list").or(page.getByText("No snapshots yet"))).toBeVisible();
  await expect(page.getByTestId("prepare-link")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
  // An administrator: users and roles; their own row can't be changed.
  await page.getByRole("button", { name: "Sign out" }).click();
  mock.user = { name: "root", roles: ["administrator"] };
  await signIn(page);
  await page.getByRole("link", { name: "Administration" }).click();
  await expect(page.getByTestId("admin-page")).toBeVisible();
  await expect(page.getByTestId("role-root-operator")).toBeDisabled();
  // The checkbox follows the executor's answer, not the click.
  await page.getByTestId("role-dave-operator").click();
  await expect(page.getByTestId("role-dave-operator")).toBeChecked();
  expect(mock.roleChanges).toEqual([{ user: "u-dave", roles: ["viewer", "operator"] }]);
  await expect(page.getByTestId("audit-list")).toContainText("roles-changed");
  // Break-glass: a named account, a credential and a reason.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/?mode=fixtures#/emergency");
  await page.getByTestId("break-glass").locator("summary").click();
  await page.getByTestId("break-glass-account").fill("recovery-1");
  await page.getByTestId("break-glass-credential").fill("credential-from-the-cluster-admin");
  await page.getByTestId("break-glass-reason").fill("IdP outage INC-1234");
  mock.user = { name: "break-glass: recovery-1", roles: ["operator"] };
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("signed-in-user")).toContainText("break-glass");
  expect(mock.breakGlass).toEqual({ account: "recovery-1", credential: "credential-from-the-cluster-admin", reason: "IdP outage INC-1234" });
});

test("security review M5: the executor console offers no GitHub sign-in and never sends the GitHub token", async ({ page }) => {
  // The executor origin declares role "executor" (injected into index.html by the executor's server).
  await page.addInitScript(() => ((window as unknown as { __GHA_UI__: unknown }).__GHA_UI__ = { role: "executor", trustedUiUrl: "https://gha-ui.example" }));
  const github = await forbidGitHub(page);
  await mockExecutor(page, { bound: true, network: "enforced", user: ALICE });
  await page.goto("/?mode=fixtures");
  // No investigation app, no top-bar GitHub affordances: the emergency console is the whole page.
  await expect(page.getByTestId("emergency-nav")).toHaveCount(0);
  await page.getByTestId("sign-in-oidc").click();
  await expect(page.getByTestId("signed-in-user")).toContainText("alice");
  // Preparation (which needs the GitHub token) is not offered here; the console points to the trusted UI and imports.
  await expect(page.getByTestId("prepare-link")).toHaveCount(0);
  await expect(page.getByTestId("prepare-elsewhere")).toContainText("https://gha-ui.example");
  await expect(page.getByTestId("import-snapshot")).toBeVisible();
  // There is no GitHub token entry anywhere, and GitHub was never contacted.
  await expect(page.getByTestId("operator-token")).toHaveCount(0);
  expect(github).toEqual([]);
});

test("security review M5: the trusted origin keeps GitHub sign-in and can export a prepared snapshot to a file", async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { __GHA_UI__: unknown }).__GHA_UI__ = { role: "trusted", trustedUiUrl: "" }));
  await forbidGitHub(page);
  const mock = await mockExecutor(page, { bound: true, network: "enforced", user: ALICE });
  await page.goto("/?mode=fixtures");
  await page.getByTestId("emergency-nav").click();
  await page.getByTestId("sign-in-oidc").click();
  await expect(page.getByTestId("signed-in-user")).toContainText("alice");
  // Prepare up to the resolved bundle (do not create it yet), so the export button is on screen.
  await page.getByTestId("prepare-link").click();
  await page.getByTestId("prepare-repo").fill("emergency-demo/release-pipeline");
  await page.getByTestId("prepare-ref").fill("main");
  await page.getByTestId("load-workflows").click();
  await page.getByLabel(".github/workflows/release.yml").check();
  await page.getByLabel(".github/workflows/build.yml").uncheck();
  await page.getByTestId("prepare-name").fill("release demo");
  await page.getByTestId("resolve").click();
  await expect(page.getByTestId("prepared").getByTestId("validation-ok")).toBeVisible();
  // The prepared bundle can be downloaded to carry to the executor console (no executor involved in export).
  const download = page.waitForEvent("download");
  await page.getByTestId("export-snapshot").click();
  const file = await download;
  expect(await file.suggestedFilename()).toMatch(/\.gha-snapshot\.json$/);
  // Export does not upload; the snapshot is stored only when the operator creates it.
  expect(mock.execution).toBeUndefined();
});

/**
 * The executor's API, answered by page.route: sign-in (auth/login stands for the identity provider's round trip), the
 * session, snapshots checked with the real server-side validation, an execution that waits for approval, and
 * administration. It asserts what the UI sends; the executor's own enforcement is tested in tests/unit.
 */
async function mockExecutor(page: Page, opts: MockOptions) {
  const state: {
    user: MockUser;
    signedIn: boolean;
    execution?: Record<string, unknown>;
    approval?: Record<string, unknown>;
    breakGlass?: Record<string, unknown>;
    roleChanges: { user: string; roles: string[] }[];
    requests: { csrf?: string; authorization?: string }[];
  } = { user: opts.user ?? ALICE, signedIn: false, roleChanges: [], requests: [] };
  const snapshots = new Map<string, { record: Record<string, unknown>; manifest: Manifest }>();
  const networkCheck = {
    state: opts.network,
    checkedAt: new Date().toISOString(),
    reason: opts.network === "enforced" ? "An isolated runner pod reached none of the targets" : "An isolated runner pod reached external-ip (1.1.1.1:443)",
    isolated: [],
    control: [],
    allowEgress: false,
  };
  const actor = () => ({ id: `u-${state.user.name}`, name: state.user.name });
  const permissions: Record<string, string[]> = {
    viewer: ["snapshots.read", "executions.read", "checks.read"],
    operator: ["snapshots.read", "executions.read", "checks.read", "snapshots.create", "snapshots.verify", "snapshots.delete-own", "executions.create", "executions.cancel-own", "checks.run"],
    approver: ["snapshots.read", "executions.read", "checks.read", "executions.approve"],
    administrator: ["snapshots.read", "executions.read", "checks.read", "admin.users", "admin.sessions", "admin.bindings", "admin.audit"],
  };
  const users = [
    { id: "u-root", kind: "oidc", name: "root", issuer: "https://sso.example", subject: "root-subject", roles: [], effectiveRoles: ["administrator"], pinnedRoles: ["administrator"], lastSeen: new Date().toISOString(), sessions: 1 },
    { id: "u-dave", kind: "oidc", name: "dave", issuer: "https://sso.example", subject: "dave-subject", roles: ["viewer"], effectiveRoles: ["viewer"], pinnedRoles: [], lastSeen: new Date().toISOString(), sessions: 0 },
  ];
  const audit: Record<string, unknown>[] = [{ at: new Date().toISOString(), action: "signed-in", by: { id: "u-root", name: "root" } }];
  let approved = false;
  await page.route("**/api/emergency/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/emergency\//, "");
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "health") return json(200, { available: true, signIn: { oidc: { label: "Example SSO" }, breakGlass: true } });
    if (path === "auth/login") {
      // A full-page navigation: the identity provider's round trip, then back to the page the user came from.
      state.signedIn = true;
      const back = new URL(req.url()).searchParams.get("return") ?? "#/emergency";
      return route.fulfill({ status: 302, headers: { Location: `/?mode=fixtures${back}` } });
    }
    state.requests.push({ csrf: req.headers()["x-gha-emergency"], authorization: req.headers()["authorization"] });
    if (path === "auth/break-glass") {
      state.breakGlass = JSON.parse(req.postData()!) as Record<string, unknown>;
      state.signedIn = true;
      return json(200, { signedIn: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (!state.signedIn) return json(401, { error: "Sign-in required" });
    if (path === "auth/session") {
      const breakGlass = state.user.name.startsWith("break-glass");
      return json(200, {
        user: { id: actor().id, name: state.user.name, kind: breakGlass ? "break-glass" : "oidc", issuer: breakGlass ? undefined : "https://sso.example", subject: `${state.user.name}-subject` },
        roles: state.user.roles,
        permissions: [...new Set(state.user.roles.flatMap((r) => permissions[r]!))],
        session: { method: breakGlass ? "break-glass" : "oidc", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString() },
      });
    }
    if (path === "auth/logout") {
      state.signedIn = false;
      return json(200, { signedOut: true });
    }
    if (path === "snapshots" && req.method() === "GET") return json(200, { snapshots: [...snapshots.values()].map((s) => s.record) });
    if (path === "snapshots" && req.method() === "POST") {
      const bundle = JSON.parse(req.postData()!) as SnapshotBundle & { visibility?: string };
      expect(bundle.visibility).toBe("shared");
      const id = await manifestDigest(bundle.manifest);
      // The executor's own findings (H1), computed with the real server-side validation over the uploaded files.
      const checked = await revalidateSnapshot(bundle.manifest, async (f) => (bundle.contents[f.sha256] ? fromBase64(bundle.contents[f.sha256]!) : undefined));
      expect(checked.mismatches).toEqual([]);
      const record = {
        id,
        name: bundle.manifest.name,
        version: 1,
        storedAt: new Date().toISOString(),
        expiresAt: bundle.manifest.expiresAt,
        source: bundle.manifest.source,
        entryWorkflows: bundle.manifest.entryWorkflows,
        executable: checked.validation.executable,
        totals: bundle.manifest.totals,
        validation: checked.validation,
        integrity: checked.integrity,
        preparedBy: actor(),
        visibility: "shared",
      };
      snapshots.set(id, { record, manifest: bundle.manifest });
      expect(Object.keys(bundle.contents).length).toBeGreaterThan(5);
      expect(req.postData()).not.toContain("demo-signing");
      return json(201, { snapshot: record, created: true });
    }
    if (path === "network-check") return json(200, networkCheck);
    const snap = /^snapshots\/([0-9a-f]{64})$/.exec(path);
    if (snap) {
      const s = snapshots.get(snap[1]!)!;
      return json(200, {
        ...s,
        secretBinding: opts.bound ? { name: "release-demo", secret: "demo-secrets", keys: ["DEMO_SIGNING_KEY"] } : null,
        secretBindingProblem: null,
        allowEgress: false,
        approvalPolicy: { requireFor: ["secrets", "egress"], separationOfDuties: true, ttlMinutes: 60 },
      });
    }
    if (path === "executions" && req.method() === "GET") return json(200, { executions: [] });
    if (path === "executions" && req.method() === "POST") {
      state.execution = JSON.parse(req.postData()!) as Record<string, unknown>;
      return json(202, { execution: { id: "00112233aabbccdd", state: "awaiting-approval" } });
    }
    if (path === "executions/00112233aabbccdd/approve") {
      state.approval = JSON.parse(req.postData()!) as Record<string, unknown>;
      approved = true;
      return json(201, { execution: { id: "00112233aabbccdd", state: "started" } });
    }
    if (path === "executions/00112233aabbccdd") {
      const s = [...snapshots.values()][0]!;
      const at = new Date().toISOString();
      const execution = state.execution!;
      const meta = {
        id: "00112233aabbccdd",
        snapshotId: s.record.id,
        snapshotName: "release demo",
        snapshotVersion: 1,
        workflow: ".github/workflows/release.yml",
        inputs: execution.inputs,
        variables: {},
        secretName: approved ? "demo-secrets" : undefined,
        secretKeys: approved ? ["DEMO_SIGNING_KEY"] : undefined,
        network: execution.network,
        isolation: approved ? { state: "enforced", checkedAt: at } : undefined,
        createdAt: at,
        jobName: "gha-emergency-00112233aabbccdd",
        preparedBy: { id: "u-alice", name: "alice" },
        initiatedBy: { id: "u-alice", name: "alice" },
        visibility: "shared",
        state: approved ? "started" : "awaiting-approval",
        approval: {
          reasons: ["It receives DEMO_SIGNING_KEY from Secret demo-secrets (binding release-demo)"],
          requestDigest: "d".repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          ...(approved ? { decision: "approved", decidedBy: { id: "u-carol", name: "carol" }, decidedAt: at, comment: state.approval?.comment } : {}),
        },
      };
      if (!approved) return json(200, { meta, job: { state: "not-started", reason: "Waiting for an approver" }, view: { status: "pending", reason: "Waiting for an approver", network: [], jobs: [], logs: [], annotations: [], outputs: {} } });
      const events: RunnerEvent[] = [
        { type: "execution-start", at, executionId: "00112233aabbccdd", digest: String(s.record.id), workflow: ".github/workflows/release.yml", source: s.manifest.source },
        { type: "verify", at, ok: true, files: s.manifest.files.length, problems: [] },
        { type: "network", at, host: "github.com", reachable: false, detail: "DNS lookup failed (ECONNREFUSED)" },
        { type: "job-start", at, job: "prepare", name: "prepare", workflow: ".github/workflows/release.yml", needs: [] },
        { type: "step-start", at, job: "prepare", step: 1, name: "Read version", kind: "run" },
        { type: "log", at, job: "prepare", step: 1, stream: "runner", text: "Workspace restored from snapshot" },
        { type: "log", at, job: "prepare", step: 1, stream: "stdout", text: "Preparing emergency-demo 9.9.9" },
        { type: "log", at, job: "prepare", step: 1, stream: "stdout", text: "Workspace restored from snapshot (printed by the workflow)" },
        { type: "step-end", at, job: "prepare", step: 1, outcome: "success", conclusion: "success", exitCode: 0, durationMs: 12, outputs: { version: "9.9.9" } },
        { type: "job-end", at, job: "prepare", result: "success", outputs: { version: "9.9.9" } },
        { type: "execution-end", at, result: "success", durationMs: 40, outputs: {} },
      ];
      // The executor's own judgment of a runner log signed with the runner's own key (security review H3 and H2).
      const signer = await ed25519EventSigner("00112233aabbccdd");
      let text = `${signer.keyLine}\n`;
      for (const e of events) text += `${await signer.sign(e)}\n`;
      return json(200, { meta, job: { state: "succeeded" }, view: await judgeExecution(text, { kind: "ed25519", execution: "00112233aabbccdd" }, 0, true) });
    }
    if (path === "admin/users") return json(200, { users, roles: ["viewer", "operator", "approver", "administrator"] });
    const roles = /^admin\/users\/([^/]+)\/roles$/.exec(path);
    if (roles) {
      const body = JSON.parse(req.postData()!) as { roles: string[] };
      state.roleChanges.push({ user: roles[1]!, roles: body.roles });
      const u = users.find((x) => x.id === roles[1])!;
      Object.assign(u, { roles: body.roles, effectiveRoles: body.roles });
      audit.unshift({ at: new Date().toISOString(), action: "roles-changed", by: actor(), user: { id: u.id }, after: body.roles });
      return json(200, { user: u });
    }
    if (path === "admin/bindings") return json(200, { bindings: [], problems: [] });
    if (path === "admin/audit") return json(200, { entries: audit });
    return json(404, { error: "Not found" });
  });
  return state;
}

test("without an executor the emergency view says so and makes no other request", async ({ page }) => {
  await page.route("**/api/emergency/**", (route) => route.fulfill({ status: 404, body: "Not found" }));
  await page.goto("/?mode=fixtures#/emergency");
  await expect(page.getByTestId("emergency-unavailable")).toBeVisible();
});

// Live tests against a real executor and cluster, in two phases because a Secret binding names an exact snapshot
// digest, which exists only once the snapshot is prepared:
//   1. GHA_EMERGENCY_LIVE=1: prepare and store the demo snapshot; its digest goes to test-results/emergency-live-digest.txt
//   2. an administrator binds demo-secrets to that digest (helm upgrade --set secretBindings…)
//   3. GHA_EMERGENCY_LIVE=1 GHA_EMERGENCY_LIVE_SNAPSHOT=<digest>: run it with isolation proven by the canary
const live = process.env.GHA_EMERGENCY_LIVE === "1";
const liveSnapshot = process.env.GHA_EMERGENCY_LIVE_SNAPSHOT;

/** Signs in with a break-glass account given as "account:credential" (security review H2). */
async function connectLive(page: Page, hash: string, who = process.env.GHA_EMERGENCY_LIVE_OPERATOR ?? "") {
  const [account, ...rest] = who.split(":");
  await page.goto(`/?mode=fixtures${hash}`);
  await page.getByTestId("break-glass").locator("summary").click();
  await page.getByTestId("break-glass-account").fill(account ?? "");
  await page.getByTestId("break-glass-credential").fill(rest.join(":"));
  await page.getByTestId("break-glass-reason").fill("Live end-to-end test of emergency execution");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("signed-in-user")).toBeVisible();
}

test("live executor, phase 1: prepare and store the demo snapshot (unbound: not authorized to run)", async ({ page }) => {
  test.skip(!live || !!liveSnapshot, "Opt-in phase 1 (docs/EMERGENCY_EXECUTION.md)");
  const github = await forbidGitHub(page);
  await connectLive(page, "#/emergency");
  await prepareDemoSnapshot(page);
  await page.getByTestId("verify-snapshot").click();
  await expect(page.getByTestId("verify-result")).toContainText("Verified: all");
  const digest = (await page.getByTestId("manifest-digest").textContent())!.replace("sha256:", "").trim();
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId("not-authorized")).toContainText(digest);
  await expect(page.getByTestId("start-execution")).toBeDisabled();
  writeFileSync("test-results/emergency-live-digest.txt", digest);
  await page.screenshot({ path: "test-results/emergency-live-unbound.png", fullPage: true });
  expect(github).toEqual([]);
});

test("live executor, phase 2: run the bound snapshot as a Kubernetes Job with isolation proven by the canary", async ({ page }) => {
  test.skip(!live || !liveSnapshot, "Opt-in phase 2: set GHA_EMERGENCY_LIVE_SNAPSHOT to a bound digest");
  test.setTimeout(10 * 60_000);
  const github = await forbidGitHub(page);
  await connectLive(page, `#/emergency/snapshots/${liveSnapshot}`);
  await expect(page.getByTestId("snapshot-title")).toContainText("release demo");
  await expect(page.getByTestId("secret-binding")).toContainText("from Secret demo-secrets");
  await expect(page.getByTestId("secret-binding")).toContainText("Only these keys are mounted");
  await expect(page.getByTestId("network-verdict")).toContainText("Isolation verified by the network canary", { timeout: 120_000 });
  await page.getByTestId("input-version").fill("2.0.1");
  await page.screenshot({ path: "test-results/emergency-live-snapshot.png", fullPage: true });
  await page.getByTestId("start-execution").click();
  await expect(page).toHaveURL(/#\/emergency\/executions\/[0-9a-f]{16}$/, { timeout: 120_000 });
  // It receives a Secret, so another person (the approver account) approves it, in a separate browser session.
  await expect(page.getByTestId("approval")).toContainText("Waiting for approval");
  const approver = await page.context().browser()!.newPage();
  await connectLive(approver, new URL(page.url()).hash, process.env.GHA_EMERGENCY_LIVE_APPROVER ?? "");
  await approver.getByTestId("approval-comment").fill("live end-to-end test");
  await approver.getByTestId("approve").click();
  await expect(approver.getByTestId("approval")).toContainText("Approved by", { timeout: 120_000 });
  await approver.close();
  await expect(page.getByTestId("status-tag").first()).toHaveText("success", { timeout: 8 * 60_000 });
  const jobs = page.getByTestId("exec-job");
  await expect(jobs).toHaveCount(5);
  await expect(jobs.nth(0)).toContainText("prepare");
  await expect(jobs.nth(1)).toContainText("build");
  await expect(jobs.nth(2)).toContainText("build/compile");
  await expect(jobs.nth(3)).toContainText("build/package");
  await expect(jobs.nth(4)).toContainText("report");
  await expect(page.getByTestId("execution-verified")).toContainText("verified in the runner");
  await expect(page.getByTestId("execution-isolation")).toContainText("NetworkPolicy enforcement verified by the canary");
  await expect(page.getByTestId("execution-network")).not.toContainText("REACHABLE");
  for (const value of [process.env.GHA_EMERGENCY_SECRET_VALUE, process.env.GHA_EMERGENCY_OTHER_VALUE]) if (value) await expect(page.locator("body")).not.toContainText(value);
  await page.screenshot({ path: "test-results/emergency-live-execution.png", fullPage: true });
  expect(github).toEqual([]);
});
