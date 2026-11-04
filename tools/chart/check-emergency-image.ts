// Security review M7. The executor is the privileged component (it creates runner Jobs, holds the service-account
// token and reads snapshots). A mutable image tag (e.g. :local) with imagePullPolicy IfNotPresent lets the content
// behind that tag change, or a stale/pre-planted image already cached under the name run, so what the executor runs
// is not fixed. This checks, on what `helm template charts/gha-emergency` renders, that the executor image is pinned
// to an immutable digest (repository@sha256:...) with IfNotPresent, that the chart fails closed without a valid
// executor.image.digest, and that no mutable-tag override can reintroduce a tag. It also guards that the runner image
// the executor is handed stays digest-pinned (security review H4).
//
//   node --disable-warning=ExperimentalWarning tools/chart/check-emergency-image.ts   (needs `helm` on PATH, or HELM=<path>)
//
// Each positive check is also run against a deliberately broken copy of the rendered default, so a check that stops
// detecting its problem fails the run too. No cluster, registry, image or credentials are involved: rendering only.
import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

const CHART = "charts/gha-emergency";
const HELM = process.env.HELM ?? "helm";
const KUBE_VERSION = "1.30.0";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- rendered manifests are untyped YAML

const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const EXECUTOR_DIGEST = `sha256:${"b".repeat(64)}`;
// The smallest set of values a valid install needs: both image digests, the trusted UI origin (M5) and one sign-in
// method (H2). Everything else keeps its default.
const BASE = [
  `runner.image.digest=${RUNNER_DIGEST}`,
  `executor.image.digest=${EXECUTOR_DIGEST}`,
  "ui.trustedUiUrl=https://trusted.example",
  "auth.breakGlass.accounts[0].name=op",
  "auth.breakGlass.accounts[0].passwordHash=$2y$dummy",
  "auth.breakGlass.accounts[0].roles[0]=operator",
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

const DIGEST_REF = /@sha256:[0-9a-f]{64}$/;
const executorDeployment = (o: Obj[]) => o.find((x) => x.kind === "Deployment" && String(x.metadata?.name ?? "").endsWith("-executor"));
const executorContainer = (o: Obj[]) => executorDeployment(o)?.spec?.template?.spec?.containers?.[0] as Obj | undefined;
const env = (c: Obj | undefined, name: string) => (c?.env ?? []).find((e: Obj) => e.name === name)?.value as string | undefined;

/** The M7 (and H4-regression) invariants of a rendered default. Returns the problems found, empty when all hold. */
function check(objs: Obj[]): string[] {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);

  const c = executorContainer(objs);
  if (!c) {
    fail("no executor Deployment / container rendered");
    return failures;
  }
  // M7: the executor image is pinned to a digest, never a mutable tag, and the pull policy is IfNotPresent.
  const image = String(c.image ?? "");
  if (!DIGEST_REF.test(image)) fail(`executor image ${JSON.stringify(image)} is not pinned by digest (repository@sha256:...)`);
  // A mutable tag would sit in the name portion before any @digest (name[:tag][@digest]); a registry port lives in an
  // earlier path component, so only a ':' in the last component before '@' is a tag.
  if (/:[\w][\w.-]*$/.test((image.split("@")[0] ?? "").split("/").pop() ?? "")) fail(`executor image ${JSON.stringify(image)} carries a mutable tag`);
  if (c.imagePullPolicy !== "IfNotPresent") fail(`executor imagePullPolicy is ${JSON.stringify(c.imagePullPolicy)}, expected IfNotPresent`);

  // H4 regression: the runner image the executor is handed is also pinned by digest.
  const runnerImage = env(c, "GHA_EMERGENCY_RUNNER_IMAGE");
  if (!runnerImage || !DIGEST_REF.test(runnerImage)) fail(`GHA_EMERGENCY_RUNNER_IMAGE is ${JSON.stringify(runnerImage)}, expected a digest reference`);

  return failures;
}

/** Overrides the chart must refuse at render time (fail closed), each with the message that proves the right cause. */
const REJECTED: [string, string[], RegExp][] = [
  ["no executor digest", BASE.filter((s) => !s.startsWith("executor.image.digest=")), /executor\.image\.digest must be/],
  ["executor digest is a tag word", [...BASE.filter((s) => !s.startsWith("executor.image.digest=")), "executor.image.digest=latest"], /executor\.image\.digest must be/],
  ["executor digest too short", [...BASE.filter((s) => !s.startsWith("executor.image.digest=")), "executor.image.digest=sha256:abc"], /executor\.image\.digest must be/],
  ["executor digest upper-case hex", [...BASE.filter((s) => !s.startsWith("executor.image.digest=")), `executor.image.digest=sha256:${"A".repeat(64)}`], /executor\.image\.digest must be/],
  ["no runner digest (H4)", BASE.filter((s) => !s.startsWith("runner.image.digest=")), /runner\.image\.digest must be/],
];

/** Mutable-tag overrides that must NOT change the rendered image: the digest still wins, the pull policy stays pinned. */
const IGNORED: [string, string[]][] = [
  ["a mutable tag override", [...BASE, "executor.image.tag=latest"]],
  ["a pull-policy override", [...BASE, "executor.image.pullPolicy=Always"]],
];

/** Broken copies of a correct render: each must be caught, or the corresponding check is not working. */
const MUTATIONS: [string, (o: Obj[]) => void][] = [
  ["executor image given a tag", (o) => (executorContainer(o)!.image = "localhost/gha-emergency-executor:local")],
  ["executor image set to :latest", (o) => (executorContainer(o)!.image = "localhost/gha-emergency-executor:latest")],
  ["executor pull policy Always", (o) => (executorContainer(o)!.imagePullPolicy = "Always")],
  ["runner image un-pinned", (o) => (executorContainer(o)!.env.find((e: Obj) => e.name === "GHA_EMERGENCY_RUNNER_IMAGE").value = "localhost/gha-emergency-runner:local")],
];

function main() {
  let failed = 0;

  const failures = check(render(BASE));
  for (const f of failures) console.log(`FAIL [defaults] ${f}`);
  console.log(`${failures.length ? "FAIL" : "ok  "} defaults render pins the executor by digest`);
  failed += failures.length;

  for (const [name, set] of IGNORED) {
    const c = executorContainer(render(set));
    const ok = c && DIGEST_REF.test(String(c.image)) && c.imagePullPolicy === "IfNotPresent";
    console.log(`${ok ? "ok  " : "FAIL"} ignored: ${name} does not change the pinned image`);
    if (!ok) failed++;
  }

  for (const [name, set, cause] of REJECTED) {
    try {
      render(set);
      console.log(`FAIL fail-closed: "${name}" rendered instead of being refused (${set.join(" ")})`);
      failed++;
    } catch (e) {
      if (e instanceof HelmError && cause.test(e.stderr)) console.log(`ok   fail-closed: ${name}`);
      else {
        console.log(`FAIL fail-closed: "${name}" failed for the wrong reason: ${e instanceof HelmError ? e.stderr.split("\n")[0] : String(e)}`);
        failed++;
      }
    }
  }

  const base = render(BASE);
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
    console.log(`${failed} emergency-chart image invariant failure(s)`);
    process.exitCode = 1;
  } else console.log("All emergency-chart image invariants hold (security review M7, H4)");
}

main();
