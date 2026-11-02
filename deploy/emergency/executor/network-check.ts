// Proof that the cluster enforces the runner NetworkPolicies (security review C2), before any isolated execution.
//
// The check runs canary Jobs (job-spec.ts buildCanaryJob):
// - a probe with exactly an isolated execution's labels and network settings tries an external IP address, the
//   Kubernetes API, the cloud metadata address and an internal service (the executor's own Service);
// - a control pod, selected by no runner policy, tries the same internal service.
// Isolation is "enforced" only when the control reaches the internal service (so the network works and the probe's
// failures are the policy's doing) and the probe reaches nothing. Otherwise it is "not-enforced" (the probe reached
// something) or "unverified" (the control failed, a canary didn't finish, or its output was unreadable). Anything
// other than "enforced" refuses isolated executions. With egress mode enabled, a probe with the egress labels must
// reach neither the Kubernetes API, the metadata address nor the internal service.
// An "enforced" result is reused for maxAgeMs; any other result only for retryMs, so a transient failure (e.g. the
// check racing the executor's own readiness at startup) doesn't refuse executions for long. Concurrent callers share
// one check.
import { randomBytes } from "node:crypto";
import { CANARY_PREFIX } from "../../../src/emergency/events.ts";
import type { CanaryRole, CanaryTarget } from "./job-spec.ts";
import { buildCanaryJob, CANARY_CHECK_LABEL, canaryJobName, RUNNER_CONTAINER } from "./job-spec.ts";
import type { KubeApi, K8sJob } from "./kube.ts";

export type ProbeResult = { name: string; host: string; port: number; reachable: boolean; detail: string };
export type CheckState = "enforced" | "not-enforced" | "unverified";
export type NetworkCheck = {
  state: CheckState | "never" | "checking";
  checkedAt?: string;
  reason?: string;
  isolated: ProbeResult[];
  control: ProbeResult[];
  /** Present when egress mode is enabled. */
  egress?: { state: CheckState; reason?: string; results: ProbeResult[] };
};

export type NetworkCheckConfig = {
  namespace: string;
  runnerImage: string;
  runnerServiceAccount: string;
  executorPodLabels: Record<string, string>;
  externalTarget: { host: string; port: number };
  /** The Kubernetes API as pods see it (the executor's KUBERNETES_SERVICE_HOST and _PORT). */
  apiServer: { host: string; port: number };
  metadataTarget: { host: string; port: number };
  /** Resolves the executor Service to an IP address and port (the internal-service target). */
  internalService: () => Promise<{ host: string; port: number }>;
  egressEnabled: boolean;
  maxAgeMs: number;
  /** How long a result other than "enforced" is reused before the next execution re-checks. */
  retryMs: number;
  timeoutMs: number;
  pollMs: number;
};

export function createNetworkCheck(deps: { kube: KubeApi; config: NetworkCheckConfig; now?: () => Date; sleep?: (ms: number) => Promise<void>; log?: (e: Record<string, unknown>) => void }) {
  const { kube, config } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  let current: NetworkCheck = { state: "never", isolated: [], control: [] };
  let running: Promise<NetworkCheck> | null = null;

  const fresh = () => current.checkedAt !== undefined && now().getTime() - Date.parse(current.checkedAt) < (current.state === "enforced" ? config.maxAgeMs : config.retryMs);

  async function runCanary(checkId: string, role: CanaryRole, targets: CanaryTarget[]): Promise<{ results?: ProbeResult[]; problem?: string }> {
    const job = buildCanaryJob({ checkId, role, targets, namespace: config.namespace, runnerImage: config.runnerImage, serviceAccountName: config.runnerServiceAccount, executorPodLabels: config.executorPodLabels });
    const name = canaryJobName(checkId, role);
    await kube.createJob(job);
    try {
      const deadline = now().getTime() + config.timeoutMs;
      let state: K8sJob | undefined;
      for (;;) {
        state = await kube.getJob(name);
        const done = state?.status?.succeeded || state?.status?.failed || state?.status?.conditions?.some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True");
        if (done) break;
        if (now().getTime() >= deadline) return { problem: `${role} canary did not finish within ${Math.round(config.timeoutMs / 1000)} s` };
        await sleep(config.pollMs);
      }
      const pods = await kube.listPods(`${CANARY_CHECK_LABEL}=${checkId}`);
      const pod = pods.find((p) => p.metadata.name.startsWith(name));
      if (!pod) return { problem: `${role} canary pod not found` };
      const text = await kube.podLog(pod.metadata.name, RUNNER_CONTAINER);
      const results = text
        .split("\n")
        .filter((l) => l.startsWith(CANARY_PREFIX))
        .map((l) => JSON.parse(l.slice(CANARY_PREFIX.length)) as ProbeResult);
      const missing = targets.filter((t) => !results.some((r) => r.name === t.name && r.host === t.host && r.port === t.port));
      if (missing.length) return { problem: `${role} canary reported no result for ${missing.map((m) => m.name).join(", ")}` };
      return { results };
    } catch (error) {
      return { problem: `${role} canary failed: ${(error as Error).message}` };
    } finally {
      await kube.deleteJob(name).catch(() => {});
    }
  }

  async function check(): Promise<NetworkCheck> {
    const checkId = randomBytes(4).toString("hex");
    current = { ...current, state: "checking" };
    let internal: { host: string; port: number };
    try {
      internal = await config.internalService();
    } catch (error) {
      current = { state: "unverified", checkedAt: now().toISOString(), reason: `Could not resolve the internal-service target: ${(error as Error).message}`, isolated: [], control: [] };
      return current;
    }
    const isolatedTargets: CanaryTarget[] = [
      { name: "external-ip", ...config.externalTarget },
      { name: "kubernetes-api", ...config.apiServer },
      { name: "cloud-metadata", ...config.metadataTarget },
      { name: "internal-service", ...internal },
    ];
    const [probe, control, egress] = await Promise.all([
      runCanary(checkId, "probe-isolated", isolatedTargets),
      runCanary(checkId, "control", [{ name: "internal-service", ...internal }]),
      config.egressEnabled ? runCanary(checkId, "probe-egress", isolatedTargets.filter((t) => t.name !== "external-ip")) : Promise.resolve(undefined),
    ]);
    const result: NetworkCheck = { state: "unverified", checkedAt: now().toISOString(), isolated: probe.results ?? [], control: control.results ?? [] };
    const controlOk = control.results?.every((r) => r.reachable) ?? false;
    if (probe.problem || control.problem) result.reason = [probe.problem, control.problem].filter(Boolean).join("; ");
    else if (!controlOk) result.reason = "The control pod could not reach the internal service, so a blocked probe proves nothing about NetworkPolicy";
    else {
      const leaks = probe.results!.filter((r) => r.reachable);
      result.state = leaks.length ? "not-enforced" : "enforced";
      result.reason = leaks.length
        ? `An isolated runner pod reached ${leaks.map((l) => `${l.name} (${l.host}:${l.port})`).join(", ")}: the cluster's network plugin does not enforce the runner NetworkPolicy`
        : "An isolated runner pod reached none of the targets, while the control pod reached the internal service";
    }
    if (config.egressEnabled && egress) {
      if (egress.problem || !controlOk) result.egress = { state: "unverified", reason: egress.problem ?? result.reason, results: egress.results ?? [] };
      else {
        const leaks = egress.results!.filter((r) => r.reachable);
        result.egress = {
          state: leaks.length ? "not-enforced" : "enforced",
          reason: leaks.length ? `An egress-mode runner pod reached ${leaks.map((l) => l.name).join(", ")}` : "An egress-mode runner pod reached neither the Kubernetes API, the metadata address nor the internal service",
          results: egress.results!,
        };
      }
    }
    log({ action: "network-check", state: result.state, egress: result.egress?.state ?? null, reason: result.reason });
    current = result;
    return result;
  }

  return {
    status: (): NetworkCheck => current,
    /** Runs a new check now (shared with any check already running). */
    run(): Promise<NetworkCheck> {
      if (!running) running = check().finally(() => (running = null));
      return running;
    },
    /** A check no older than maxAgeMs, running one if needed. */
    async ensureFresh(): Promise<NetworkCheck> {
      if (fresh() && current.state !== "checking") return current;
      return this.run();
    },
  };
}

export type NetworkChecker = ReturnType<typeof createNetworkCheck>;
