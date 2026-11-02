// Proof that the API server enforces the chart's runner admission policy (security review H4), before any execution.
//
// RBAC lets the executor create Jobs but can't constrain what they contain; the ValidatingAdmissionPolicy in
// charts/gha-emergency/templates/admission-policy.yaml does, independently of this code. Installed is not enforced
// (an API server without the feature, a deleted binding, a namespace outside the binding), so the executor asks the
// API server itself, with two server-side dry runs (dryRun=All: admission runs, nothing is stored or scheduled):
// - a canary-shaped Job that differs from a legitimate one only by a hostPath volume must be denied, by the policy;
// - the same Job without it must be accepted (the policy also refuses namespaces that aren't dedicated and
//   "restricted", so this proves the namespace too).
// Only then is the policy "enforced". Anything else refuses executions. Dry runs need only the executor's existing
// "create jobs" permission.
import { randomBytes } from "node:crypto";
import { buildCanaryJob } from "./job-spec.ts";
import { KubeError, type KubeApi } from "./kube.ts";

export type AdmissionState = "enforced" | "not-enforced" | "unverified";
export type AdmissionCheck = { state: AdmissionState | "never" | "checking"; checkedAt?: string; reason?: string };

export type AdmissionCheckConfig = {
  namespace: string;
  runnerImage: string;
  runnerServiceAccount: string;
  executorPodLabels: Record<string, string>;
  /** Name of the ValidatingAdmissionPolicy; its denials name it. */
  policyName: string;
  maxAgeMs: number;
  retryMs: number;
};

export const admissionProbeName = (checkId: string, kind: "denied" | "accepted") => `gha-emergency-admission-${checkId}-${kind}`;

/** The two dry-run Jobs: identical except for the hostPath volume the policy must refuse. */
export function admissionProbes(config: AdmissionCheckConfig, checkId: string) {
  const base = { checkId, role: "probe-isolated" as const, targets: [], namespace: config.namespace, runnerImage: config.runnerImage, serviceAccountName: config.runnerServiceAccount, executorPodLabels: config.executorPodLabels };
  const accepted = buildCanaryJob(base);
  accepted.metadata.name = admissionProbeName(checkId, "accepted");
  const denied = buildCanaryJob(base);
  denied.metadata.name = admissionProbeName(checkId, "denied");
  (denied.spec.template.spec.volumes as object[]).push({ name: "host", hostPath: { path: "/" } });
  return { accepted, denied };
}

export function createAdmissionCheck(deps: { kube: KubeApi; config: AdmissionCheckConfig; now?: () => Date; log?: (e: Record<string, unknown>) => void }) {
  const { kube, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let current: AdmissionCheck = { state: "never" };
  let running: Promise<AdmissionCheck> | null = null;

  const fresh = () => current.checkedAt !== undefined && now().getTime() - Date.parse(current.checkedAt) < (current.state === "enforced" ? config.maxAgeMs : config.retryMs);
  const byPolicy = (e: unknown) => e instanceof KubeError && (e.status === 403 || e.status === 422) && e.message.includes(`ValidatingAdmissionPolicy '${config.policyName}'`);

  async function check(): Promise<AdmissionCheck> {
    current = { ...current, state: "checking" };
    const { accepted, denied } = admissionProbes(config, randomBytes(4).toString("hex"));
    let result: AdmissionCheck;
    let deniedError: unknown;
    try {
      await kube.createJob(denied, { dryRun: true });
    } catch (error) {
      deniedError = error;
    }
    if (deniedError === undefined) result = { state: "not-enforced", reason: `The API server accepted a runner Job with a hostPath volume: the admission policy ${config.policyName} is not enforced in namespace ${config.namespace}` };
    else if (!byPolicy(deniedError)) result = { state: "unverified", reason: `A runner Job with a hostPath volume was refused, but not by the admission policy ${config.policyName}: ${(deniedError as Error).message}` };
    else {
      try {
        await kube.createJob(accepted, { dryRun: true });
        result = { state: "enforced", reason: `The admission policy ${config.policyName} refused a runner Job with a hostPath volume and accepted the legitimate one` };
      } catch (error) {
        result = { state: "unverified", reason: `The API server refused a legitimate runner Job: ${(error as Error).message}` };
      }
    }
    current = { ...result, checkedAt: now().toISOString() };
    log({ action: "admission-check", state: current.state, reason: current.reason });
    return current;
  }

  return {
    status: (): AdmissionCheck => current,
    run(): Promise<AdmissionCheck> {
      if (!running) running = check().finally(() => (running = null));
      return running;
    },
    async ensureFresh(): Promise<AdmissionCheck> {
      if (fresh() && current.state !== "checking") return current;
      return this.run();
    },
  };
}

export type AdmissionChecker = ReturnType<typeof createAdmissionCheck>;
