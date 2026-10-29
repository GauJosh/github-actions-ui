// Security and wiring invariants of charts/gha-ui, checked on what `helm template` renders: the things a template
// change could break without the values schema noticing. Not a general policy engine.
//
//   node --disable-warning=ExperimentalWarning tools/chart/check-chart.ts      (needs `helm` on PATH, or HELM=<path>)
//
// Each check is also run against deliberately broken copies of the rendered default, so a check that stops
// detecting its problem fails the run too. Unsafe overrides must be refused by values.schema.json before anything
// renders, and the supported overrides in VARIANTS must keep rendering. No cluster, registry or credentials are
// involved.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseAllDocuments, parse } from "yaml";

const CHART = "charts/gha-ui";
const HELM = process.env.HELM ?? "helm";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- rendered manifests are untyped YAML
type Variant = { name: string; set: string[]; basePath: string | null; containerPort: number };

const VARIANTS: Variant[] = [
  { name: "defaults", set: [], basePath: null, containerPort: 8080 },
  { name: "subpath /gha-ui/", set: ["basePath=/gha-ui/"], basePath: "/gha-ui/", containerPort: 8080 },
  { name: "root basePath /", set: ["basePath=/"], basePath: "/", containerPort: 8080 },
  {
    name: "overrides (replicas, NodePort, digest, pull secret, port, no UID)",
    set: ["replicaCount=3", "service.type=NodePort", `image.digest=sha256:${"a".repeat(64)}`, "imagePullSecrets[0]=regcred", "containerPort=9090", "securityContext.runAsUser=null", "podSecurityContext.runAsUser=null"],
    basePath: null,
    containerPort: 9090,
  },
  {
    name: "registry image, seccomp on the container only",
    set: ["image.repository=registry.example.com/team/gha-ui", "image.tag=2026.10.28-abc1234", "podSecurityContext.seccompProfile=null"],
    basePath: null,
    containerPort: 8080,
  },
  { name: "seccomp on the pod only", set: ["securityContext.seccompProfile=null"], basePath: null, containerPort: 8080 },
  {
    name: "Localhost seccomp profile on the container",
    set: ["securityContext.seccompProfile.type=Localhost", "securityContext.seccompProfile.localhostProfile=profiles/gha-ui.json"],
    basePath: null,
    containerPort: 8080,
  },
];

/** Overrides values.schema.json must refuse: each would weaken the pod, or is outside what the chart supports. */
const REJECTED: [string, string[]][] = [
  ["service-account token mounted", ["serviceAccount.automountServiceAccountToken=true"]],
  ["seccomp removed from the pod and the container", ["podSecurityContext.seccompProfile=null", "securityContext.seccompProfile=null"]],
  ["seccomp Unconfined on the container", ["securityContext.seccompProfile.type=Unconfined"]],
  ["seccomp Unconfined on the pod", ["podSecurityContext.seccompProfile.type=Unconfined"]],
  ["seccomp Localhost without a profile", ["securityContext.seccompProfile.type=Localhost"]],
  ["seccomp Localhost with an empty profile", ["securityContext.seccompProfile.type=Localhost", "securityContext.seccompProfile.localhostProfile="]],
  ["seccomp Localhost with an absolute profile", ["securityContext.seccompProfile.type=Localhost", "securityContext.seccompProfile.localhostProfile=/etc/profile.json"]],
  ["seccomp Localhost with a parent-directory profile", ["podSecurityContext.seccompProfile.type=Localhost", "podSecurityContext.seccompProfile.localhostProfile=../profile.json"]],
  ["seccomp RuntimeDefault with a profile", ["securityContext.seccompProfile.localhostProfile=profiles/gha-ui.json"]],
  ["seccomp unknown key", ["securityContext.seccompProfile.mode=permissive"]],
  ["procMount Unmasked", ["securityContext.procMount=Unmasked"]],
  ["unknown container securityContext key (seLinuxOptions)", ["securityContext.seLinuxOptions.type=spc_t"]],
  ["unknown container securityContext key (windowsOptions)", ["securityContext.windowsOptions.hostProcess=true"]],
  ["container root UID", ["securityContext.runAsUser=0"]],
  ["pod root UID", ["podSecurityContext.runAsUser=0"]],
  ["pod runAsNonRoot removed", ["podSecurityContext.runAsNonRoot=null"]],
  ["container runAsNonRoot false", ["securityContext.runAsNonRoot=false"]],
  ["privileged", ["securityContext.privileged=true"]],
  ["privilege escalation", ["securityContext.allowPrivilegeEscalation=true"]],
  ["writable root filesystem", ["securityContext.readOnlyRootFilesystem=false"]],
  ["capability added", ["securityContext.capabilities.add[0]=NET_ADMIN"]],
  ["capabilities not all dropped", ["securityContext.capabilities.drop[0]=NET_RAW"]],
  ["latest tag", ["image.tag=latest"]],
  ["relative basePath", ["basePath=gha-ui/"]],
  ["privileged port", ["containerPort=80"]],
];

const ALLOWED_KINDS = new Set(["ServiceAccount", "Service", "Deployment", "Pod"]);
const RBAC_KINDS = new Set(["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"]);

class HelmError extends Error {
  readonly stderr: string;
  constructor(stderr: string, options: ErrorOptions) {
    super(`helm template failed: ${stderr}`, options);
    this.stderr = stderr;
  }
}

function render(set: string[]): Obj[] {
  const args = ["template", "gha-ui", CHART, "--namespace", "gha-ui", ...set.flatMap((s) => ["--set", s])];
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

/** The hardening every container of the chart (the UI and the test pod) must keep. */
function hardened(pod: Obj, container: Obj, where: string, fail: (m: string) => void) {
  const psc = pod.securityContext ?? {};
  const sc = container.securityContext ?? {};
  if (pod.automountServiceAccountToken !== false) fail(`${where}: automountServiceAccountToken is not false`);
  if (psc.runAsNonRoot !== true) fail(`${where}: pod runAsNonRoot is not true`);
  if (sc.runAsNonRoot === false) fail(`${where}: container runAsNonRoot is false`);
  for (const uid of [psc.runAsUser, sc.runAsUser]) if (uid === 0) fail(`${where}: runs as UID 0`);
  if (sc.allowPrivilegeEscalation !== false) fail(`${where}: allowPrivilegeEscalation is not false`);
  if (sc.readOnlyRootFilesystem !== true) fail(`${where}: readOnlyRootFilesystem is not true`);
  if (sc.privileged === true) fail(`${where}: privileged`);
  if (sc.procMount !== undefined && sc.procMount !== "Default") fail(`${where}: procMount is ${sc.procMount}`);
  if (!(sc.capabilities?.drop ?? []).includes("ALL")) fail(`${where}: capabilities do not drop ALL`);
  if ((sc.capabilities?.add ?? []).length) fail(`${where}: capabilities added: ${sc.capabilities.add.join(", ")}`);
  // The container's profile overrides the pod's. Localhost needs a relative profile path; RuntimeDefault takes none.
  const seccomp = sc.seccompProfile ?? psc.seccompProfile;
  const profile = seccomp?.localhostProfile;
  if (seccomp?.type === "RuntimeDefault") {
    if (profile !== undefined) fail(`${where}: RuntimeDefault seccomp with a localhostProfile`);
  } else if (seccomp?.type === "Localhost") {
    if (typeof profile !== "string" || !/^[\w.-]+(\/[\w.-]+)*$/.test(profile) || profile.split("/").includes("..")) fail(`${where}: Localhost seccomp without a valid relative localhostProfile (${String(profile)})`);
  } else fail(`${where}: seccompProfile is ${String(seccomp?.type)}, not RuntimeDefault or Localhost`);
  for (const host of ["hostNetwork", "hostPID", "hostIPC"]) if (pod[host]) fail(`${where}: ${host}`);
  if ((pod.volumes ?? []).length) fail(`${where}: has volumes (${pod.volumes.map((v: Obj) => v.name).join(", ")})`);
  if ((container.volumeMounts ?? []).length) fail(`${where}: has volume mounts`);
  if (/:latest$/.test(container.image) || !/[:@]/.test(container.image.split("/").pop())) fail(`${where}: image ${container.image} has no pinned tag or digest`);
}

function check(objs: Obj[], v: Pick<Variant, "basePath" | "containerPort">): string[] {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  const of = (kind: string) => objs.filter((o) => o.kind === kind);

  for (const o of objs) {
    if (RBAC_KINDS.has(o.kind)) fail(`RBAC resource rendered: ${o.kind}/${o.metadata?.name}`);
    else if (!ALLOWED_KINDS.has(o.kind)) fail(`unexpected resource rendered: ${o.kind}/${o.metadata?.name}`);
    if (o.metadata?.namespace && o.metadata.namespace !== "gha-ui") fail(`${o.kind}/${o.metadata.name} targets namespace ${o.metadata.namespace}`);
  }
  const [deploy, svc, sa] = [of("Deployment"), of("Service"), of("ServiceAccount")];
  const tests = of("Pod");
  if (deploy.length !== 1 || svc.length !== 1 || sa.length !== 1 || tests.length !== 1) {
    fail(`expected one Deployment, Service, ServiceAccount and test Pod; got ${deploy.length}, ${svc.length}, ${sa.length}, ${tests.length}`);
    return failures;
  }
  const d = deploy[0]!;
  const s = svc[0]!;
  const t = tests[0]!;
  const pod = d.spec.template.spec;
  const containers: Obj[] = pod.containers ?? [];

  // The frontend alone: one container, no init containers or sidecars, and nothing pointing at a backend.
  if (containers.length !== 1 || (pod.initContainers ?? []).length) fail(`the pod has ${containers.length} containers and ${(pod.initContainers ?? []).length} init containers; expected only the UI`);
  const c = containers[0] ?? {};
  hardened(pod, c, "Deployment", fail);
  if (sa[0]!.automountServiceAccountToken !== false) fail("ServiceAccount: automountServiceAccountToken is not false");
  if (pod.serviceAccountName !== sa[0]!.metadata.name) fail(`Deployment uses ServiceAccount ${pod.serviceAccountName}, not ${sa[0]!.metadata.name}`);

  const env = new Map<string, string>((c.env ?? []).map((e: Obj) => [e.name, e.value]));
  const extra = [...env.keys()].filter((k) => k !== "PORT" && k !== "GHA_UI_BASE_PATH");
  if (extra.length || (c.envFrom ?? []).length) fail(`unexpected environment (a backend or other dependency?): ${[...extra, ...(c.envFrom ?? []).map(() => "envFrom")].join(", ")}`);
  if (env.get("PORT") !== String(v.containerPort)) fail(`PORT is ${env.get("PORT")}, expected ${v.containerPort}`);
  if (v.basePath === null || v.basePath === "") {
    if (env.has("GHA_UI_BASE_PATH")) fail("GHA_UI_BASE_PATH is set without basePath");
  } else if (env.get("GHA_UI_BASE_PATH") !== v.basePath) fail(`GHA_UI_BASE_PATH is ${env.get("GHA_UI_BASE_PATH")}, expected ${v.basePath}`);

  const port = (c.ports ?? []).find((p: Obj) => p.name === "http");
  if (!port || port.containerPort !== v.containerPort) fail(`container port "http" is ${port?.containerPort}, expected ${v.containerPort}`);
  for (const probe of ["startupProbe", "livenessProbe", "readinessProbe"]) {
    const g = c[probe]?.httpGet;
    if (!g || g.path !== "/healthz" || g.port !== "http") fail(`${probe} is not GET /healthz on port "http"`);
  }

  // Service → pods: the selector is the Deployment's, picks its pods, never the test pod, and targets the named port.
  const selector: Obj = s.spec.selector ?? {};
  const matches = (labels: Obj = {}) => Object.keys(selector).length > 0 && Object.entries(selector).every(([k, val]) => labels[k] === val);
  if (JSON.stringify(selector) !== JSON.stringify(d.spec.selector?.matchLabels)) fail("Service selector differs from the Deployment selector");
  if (!matches(d.spec.template.metadata.labels)) fail("Service selector does not match the Deployment's pods");
  if (matches(t.metadata.labels)) fail("Service selector matches the test pod");
  const sp: Obj[] = s.spec.ports ?? [];
  if (sp.length !== 1 || sp[0]!.targetPort !== "http") fail(`Service targetPort is ${sp[0]?.targetPort}, expected the named port "http"`);

  // The test pod: a Helm test hook, as hardened as the UI.
  if (t.metadata.annotations?.["helm.sh/hook"] !== "test") fail("test Pod is not a helm.sh/hook: test");
  for (const tc of t.spec.containers ?? []) hardened(t.spec, tc, "test Pod", fail);
  const base = (t.spec.containers?.[0]?.env ?? []).find((e: Obj) => e.name === "BASE")?.value;
  if (base !== (v.basePath || "/")) fail(`test Pod checks base path ${base}, expected ${v.basePath || "/"}`);
  return failures;
}

/** Broken copies of a correct render: each must be caught, or the corresponding check is not working. */
const MUTATIONS: [string, (o: Obj[]) => void][] = [
  ["pod token mounted", (o) => (pod(o).automountServiceAccountToken = true)],
  ["ServiceAccount token mounted", (o) => (o.find((x) => x.kind === "ServiceAccount")!.automountServiceAccountToken = true)],
  ["root UID", (o) => (container(o).securityContext.runAsUser = 0)],
  ["runAsNonRoot removed", (o) => delete pod(o).securityContext.runAsNonRoot],
  ["writable root filesystem", (o) => (container(o).securityContext.readOnlyRootFilesystem = false)],
  ["privilege escalation", (o) => delete container(o).securityContext.allowPrivilegeEscalation],
  ["capabilities kept", (o) => (container(o).securityContext.capabilities = { drop: ["NET_RAW"] })],
  ["capability added", (o) => (container(o).securityContext.capabilities.add = ["NET_ADMIN"])],
  ["privileged", (o) => (container(o).securityContext.privileged = true)],
  ["seccomp unconfined", (o) => ((container(o).securityContext.seccompProfile = { type: "Unconfined" }), (pod(o).securityContext.seccompProfile = { type: "Unconfined" }))],
  ["seccomp removed", (o) => (delete container(o).securityContext.seccompProfile, delete pod(o).securityContext.seccompProfile)],
  ["seccomp Localhost without a profile", (o) => (container(o).securityContext.seccompProfile = { type: "Localhost" })],
  ["seccomp Localhost with a parent-directory profile", (o) => (container(o).securityContext.seccompProfile = { type: "Localhost", localhostProfile: "../x.json" })],
  ["seccomp RuntimeDefault with a profile", (o) => (container(o).securityContext.seccompProfile = { type: "RuntimeDefault", localhostProfile: "x.json" })],
  ["procMount unmasked", (o) => (container(o).securityContext.procMount = "Unmasked")],
  ["host network", (o) => (pod(o).hostNetwork = true)],
  ["volume", (o) => (pod(o).volumes = [{ name: "tmp", emptyDir: {} }])],
  ["RBAC", (o) => o.push({ kind: "ClusterRoleBinding", metadata: { name: "x" } })],
  ["backend env", (o) => container(o).env.push({ name: "BACKEND_URL", value: "http://gha-backend" })],
  ["sidecar", (o) => pod(o).containers.push({ ...container(o), name: "sidecar" })],
  ["probe path", (o) => (container(o).livenessProbe.httpGet.path = "/")],
  ["numeric targetPort", (o) => (o.find((x) => x.kind === "Service")!.spec.ports[0].targetPort = 8080)],
  ["selector drift", (o) => (o.find((x) => x.kind === "Service")!.spec.selector = { app: "other" })],
  ["test pod selected", (o) => Object.assign(o.find((x) => x.kind === "Pod")!.metadata.labels, o.find((x) => x.kind === "Service")!.spec.selector)],
  ["base path env without basePath", (o) => container(o).env.push({ name: "GHA_UI_BASE_PATH", value: "/x/" })],
  ["latest image", (o) => (container(o).image = "localhost/gha-ui:latest")],
];
const pod = (o: Obj[]) => o.find((x) => x.kind === "Deployment")!.spec.template.spec;
const container = (o: Obj[]) => pod(o).containers[0];

function main() {
  let failed = 0;
  const chart = parse(readFileSync(`${CHART}/Chart.yaml`, "utf8")) as Obj;
  if (chart.dependencies?.length) {
    console.log(`FAIL Chart.yaml: has dependencies (${chart.dependencies.map((x: Obj) => x.name).join(", ")})`);
    failed++;
  }
  for (const v of VARIANTS) {
    const failures = check(render(v.set), v);
    for (const f of failures) console.log(`FAIL [${v.name}] ${f}`);
    console.log(`${failures.length ? "FAIL" : "ok  "} ${v.name}`);
    failed += failures.length;
  }
  for (const [name, set] of REJECTED) {
    try {
      render(set);
      console.log(`FAIL schema: "${name}" was accepted (${set.join(" ")})`);
      failed++;
    } catch (e) {
      // Refused by the values schema, not by an unrelated template error.
      if (!(e instanceof HelmError) || !e.stderr.includes("values don't meet the specifications of the schema")) throw e;
    }
  }
  console.log(`schema: ${REJECTED.length} unsafe overrides, ${failed ? "see failures above" : "all refused"}`);

  const base = render([]);
  for (const [name, mutate] of MUTATIONS) {
    const copy = structuredClone(base);
    mutate(copy);
    const caught = check(copy, VARIANTS[0]!).length > 0;
    if (!caught) {
      console.log(`FAIL self-test: "${name}" was not detected`);
      failed++;
    }
  }
  console.log(`self-test: ${MUTATIONS.length} broken renders, ${failed ? "see failures above" : "all detected"}`);
  if (failed) {
    console.log(`${failed} chart invariant failure(s)`);
    process.exitCode = 1;
  } else console.log("All chart invariants hold");
}

main();
