// Security review L1. Checks, on what `helm template charts/gha-emergency` renders, the namespace ResourceQuota and
// LimitRange that bound the dedicated namespace: the quota is the hard backstop behind the executor's (racy)
// concurrency check, and the LimitRange's per-container max matches the admission policy's runner cap (H4) so they
// never conflict. It asserts the pod cap is derived from the executor plus runner.maxConcurrent plus headroom, that
// the quota tracks pods (not Jobs, so finished Jobs don't exhaust it) and omits ephemeral-storage (which the executor
// pod doesn't set), and that an insufficient or missing configuration is refused (fail closed).
//
//   node --disable-warning=ExperimentalWarning tools/chart/check-emergency-quota.ts   (needs `helm` on PATH, or HELM=<path>)
//
// Each positive check is also run against a deliberately broken copy of the default render. No cluster is involved.
import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

const CHART = "charts/gha-emergency";
const HELM = process.env.HELM ?? "helm";
const KUBE_VERSION = "1.30.0";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- rendered manifests are untyped YAML

// The minimum a valid install needs, plus explicit, known values for everything this check asserts (so it does not
// depend on the chart defaults staying put). runner.resources and the quota sizes are pinned here.
const BASE = [
  `runner.image.digest=sha256:${"a".repeat(64)}`,
  `executor.image.digest=sha256:${"b".repeat(64)}`,
  "ui.trustedUiUrl=https://trusted.example",
  "auth.breakGlass.accounts[0].name=op",
  "auth.breakGlass.accounts[0].passwordHash=$2y$dummy",
  "auth.breakGlass.accounts[0].roles[0]=operator",
  "runner.maxConcurrent=2",
  "runner.resources.cpu=1",
  "runner.resources.memory=1Gi",
  "resourceQuota.extraPods=4",
  "resourceQuota.requestsCpu=1",
  "resourceQuota.requestsMemory=1Gi",
  "resourceQuota.limitsCpu=4",
  "resourceQuota.limitsMemory=5Gi",
];

class HelmError extends Error {
  readonly stderr: string;
  constructor(stderr: string, options: ErrorOptions) {
    super(`helm template failed: ${stderr}`, options);
    this.stderr = stderr;
  }
}

function render(set: string[]): Obj[] {
  const args = ["template", "gha-emergency", CHART, "--namespace", "gha-emergency", "--kube-version", KUBE_VERSION, ...set.flatMap((s) => ["--set", s])];
  let out: string;
  try {
    out = execFileSync(HELM, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new Error(`helm not found (${HELM}): install Helm 3 or set HELM=<path>`, { cause: e });
    throw new HelmError(err.stderr ?? err.message, { cause: e });
  }
  return parseAllDocuments(out, { uniqueKeys: true }).flatMap((d) => {
    if (d.errors.length) throw new Error(`rendered YAML is invalid: ${d.errors.map((x) => x.message).join("; ")}`);
    const o = d.toJS() as Obj | null;
    return o ? [o] : [];
  });
}

const quotaOf = (o: Obj[]) => o.find((x) => x.kind === "ResourceQuota");
const limitRangeOf = (o: Obj[]) => o.find((x) => x.kind === "LimitRange");
const containerLimit = (o: Obj[]) => (limitRangeOf(o)?.spec?.limits ?? []).find((l: Obj) => l.type === "Container");

/** The L1 invariants of a rendered default (BASE). Returns the problems found, empty when all hold. */
function check(objs: Obj[]): string[] {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);

  const q = quotaOf(objs);
  if (!q) {
    fail("no ResourceQuota rendered");
  } else {
    const hard = q.spec?.hard ?? {};
    // Derived pod cap: 1 executor + runner.maxConcurrent (2) + extraPods (4).
    if (String(hard.pods) !== "7") fail(`ResourceQuota pods is ${JSON.stringify(hard.pods)}, expected "7" (1 + maxConcurrent 2 + extraPods 4)`);
    for (const [k, want] of [["requests.cpu", "1"], ["requests.memory", "1Gi"], ["limits.cpu", "4"], ["limits.memory", "5Gi"]] as const) {
      if (String(hard[k]) !== want) fail(`ResourceQuota ${k} is ${JSON.stringify(hard[k])}, expected ${JSON.stringify(want)}`);
    }
    // Must track pods, not Jobs (finished Jobs linger until TTL and would otherwise exhaust a Job-count quota).
    if ("count/jobs.batch" in hard) fail("ResourceQuota tracks count/jobs.batch; finished Jobs would exhaust it (should track pods only)");
    // Must not track ephemeral-storage: the executor pod sets none, so the quota would reject it.
    for (const k of ["requests.ephemeral-storage", "limits.ephemeral-storage"]) if (k in hard) fail(`ResourceQuota tracks ${k}; the executor pod sets no ephemeral-storage and would be rejected`);
    if (q.metadata?.namespace !== "gha-emergency") fail(`ResourceQuota targets namespace ${q.metadata?.namespace}, expected gha-emergency`);
  }

  const c = containerLimit(objs);
  if (!c) {
    fail("no Container LimitRange rendered");
  } else {
    // The per-container max must equal the runner cap, matching the admission policy (H4) — never tighter.
    if (String(c.max?.cpu) !== "1" || String(c.max?.memory) !== "1Gi") fail(`LimitRange Container max is ${JSON.stringify(c.max)}, expected the runner cap { cpu: 1, memory: 1Gi }`);
    if (!c.default?.cpu || !c.default?.memory || !c.defaultRequest?.cpu || !c.defaultRequest?.memory) fail(`LimitRange Container must set default and defaultRequest for cpu and memory (got default ${JSON.stringify(c.default)}, defaultRequest ${JSON.stringify(c.defaultRequest)})`);
  }
  return failures;
}

/** Configurations the chart must refuse at render time (fail closed), each with the message proving the cause. */
const REJECTED: [string, string[], RegExp][] = [
  ["extraPods below the canary minimum", [...BASE.filter((s) => !s.startsWith("resourceQuota.extraPods=")), "resourceQuota.extraPods=1"], /extraPods must be at least 2/],
  ["a missing quota CPU request", [...BASE.filter((s) => !s.startsWith("resourceQuota.requestsCpu=")), "resourceQuota.requestsCpu="], /requestsCpu is required/],
  ["a missing quota memory limit", [...BASE.filter((s) => !s.startsWith("resourceQuota.limitsMemory=")), "resourceQuota.limitsMemory="], /limitsMemory is required/],
];

/** The pod cap scales with runner.maxConcurrent and extraPods; disabling removes the resources. */
function derived(): string[] {
  const failures: string[] = [];
  const podsFor = (extra: number, concurrent: number) => String(quotaOf(render([...BASE.filter((s) => !s.startsWith("resourceQuota.extraPods=") && !s.startsWith("runner.maxConcurrent=")), `resourceQuota.extraPods=${extra}`, `runner.maxConcurrent=${concurrent}`]))?.spec?.hard?.pods);
  if (podsFor(3, 5) !== "9") failures.push(`pods with maxConcurrent 5, extraPods 3 is ${podsFor(3, 5)}, expected "9"`);
  const noQuota = render([...BASE, "resourceQuota.enabled=false"]);
  if (quotaOf(noQuota)) failures.push("ResourceQuota still rendered with resourceQuota.enabled=false");
  const noLimit = render([...BASE, "limitRange.enabled=false"]);
  if (limitRangeOf(noLimit)) failures.push("LimitRange still rendered with limitRange.enabled=false");
  // The LimitRange max tracks runner.resources (so it stays equal to the admission policy's cap, never tighter).
  const bigRunner = render([...BASE.filter((s) => !s.startsWith("runner.resources.cpu=")), "runner.resources.cpu=2"]);
  if (String(containerLimit(bigRunner)?.max?.cpu) !== "2") failures.push(`LimitRange max cpu did not follow runner.resources.cpu=2 (got ${String(containerLimit(bigRunner)?.max?.cpu)})`);
  return failures;
}

/** Broken copies of a correct render: each must be caught, or the corresponding check is not working. */
const MUTATIONS: [string, (o: Obj[]) => void][] = [
  ["pod cap too low", (o) => (quotaOf(o)!.spec.hard.pods = "2")],
  ["quota tracks jobs", (o) => (quotaOf(o)!.spec.hard["count/jobs.batch"] = "5")],
  ["quota tracks ephemeral-storage", (o) => (quotaOf(o)!.spec.hard["requests.ephemeral-storage"] = "10Gi")],
  ["LimitRange max above the runner cap", (o) => (containerLimit(o)!.max.cpu = "4")],
  ["LimitRange default removed", (o) => delete containerLimit(o)!.default],
];

function main() {
  let failed = 0;

  const base = render(BASE);
  const failures = check(base);
  for (const f of failures) console.log(`FAIL [defaults] ${f}`);
  console.log(`${failures.length ? "FAIL" : "ok  "} defaults render a sound quota and limit range`);
  failed += failures.length;

  for (const f of derived()) {
    console.log(`FAIL [derived] ${f}`);
    failed++;
  }
  console.log(`${failed ? "FAIL" : "ok  "} derived values (pod cap scaling, enable flags, LimitRange max)`);

  for (const [name, set, cause] of REJECTED) {
    try {
      render(set);
      console.log(`FAIL fail-closed: "${name}" rendered instead of being refused`);
      failed++;
    } catch (e) {
      if (e instanceof HelmError && cause.test(e.stderr)) console.log(`ok   fail-closed: ${name}`);
      else {
        console.log(`FAIL fail-closed: "${name}" failed for the wrong reason: ${e instanceof HelmError ? e.stderr.split("\n")[0] : String(e)}`);
        failed++;
      }
    }
  }

  for (const [name, mutate] of MUTATIONS) {
    const copy = structuredClone(base);
    mutate(copy);
    if (check(copy).length === 0) {
      console.log(`FAIL self-test: "${name}" was not detected`);
      failed++;
    }
  }
  console.log(`self-test: ${MUTATIONS.length} broken renders, ${failed ? "see failures above" : "all detected"}`);

  if (failed) {
    console.log(`${failed} emergency-chart quota invariant failure(s)`);
    process.exitCode = 1;
  } else console.log("All emergency-chart quota invariants hold (security review L1)");
}

main();
