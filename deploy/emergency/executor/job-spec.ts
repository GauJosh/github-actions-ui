// The Kubernetes Jobs the executor creates: one per emergency execution, and the network canary
// (network-check.ts). Pure, so their security properties are unit-tested (tests/unit/emergency-*.test.ts).
//
// Every runner pod gets:
// - no Kubernetes API access: its own service account with no role bindings, and no token mounted;
// - non-root, read-only root filesystem, no capabilities, no privilege escalation, RuntimeDefault seccomp;
// - CPU, memory and scratch-space limits, an active deadline and no retries.
// An execution pod also gets:
// - the snapshot read-only (the executor's volume, subPath of the snapshot's digest directory);
// - only the Secret keys its snapshot requires, from the Secret its binding names (bindings.ts), as files.
//
// Network (security review C2). The boundary is NetworkPolicy, enforced by the cluster's network plugin and proved
// by the canary before isolated executions run. Pods are labelled with their network mode:
// - "isolated": the chart's baseline policy denies all ingress and egress;
// - "egress" (opt-in, NOT isolated): egress to public addresses, never to private, link-local or metadata ranges.
// GitHub's hostnames resolving to 127.0.0.1, and no DNS in isolated mode, remain as defence in depth only.
export const RUNNER_CONTAINER = "runner";
export const GITHUB_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "uploads.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "pipelines.actions.githubusercontent.com",
  "results-receiver.actions.githubusercontent.com",
  "token.actions.githubusercontent.com",
  "ghcr.io",
  "pkg-containers.githubusercontent.com",
];

export type NetworkMode = "isolated" | "egress";
/** The runner's execute-only node binary (deploy/emergency/Dockerfile). */
export const RUNNER_NODE = "/usr/local/libexec/gha-emergency-runner-node";
export const NETWORK_LABEL = "gha-emergency.github-actions-ui/network";
export const ROLE_LABEL = "gha-emergency.github-actions-ui/role";
export const EXECUTION_LABEL = "gha-emergency.github-actions-ui/execution";
/** Labels the chart's NetworkPolicies select (charts/gha-emergency/templates/networkpolicy.yaml). */
export const RUNNER_POD_LABELS = { "app.kubernetes.io/name": "gha-emergency-runner", "app.kubernetes.io/managed-by": "gha-emergency-executor" };

/**
 * Where a runner pod runs, relative to the trusted executor (security review M4). Set by a cluster administrator and
 * enforced by both the executor (it refuses to build a Job without a valid mode) and the admission policy (H4).
 * - "colocated": pinned to the executor's node by pod affinity, so the ReadWriteOnce snapshot volume can be shared.
 *   This is the original behaviour and the weakest: a container escape reaches the node holding the executor's
 *   service-account token, snapshots and logs. It is now an explicit, documented choice, not a silent default.
 * - "sandbox": still co-located (so the RWO volume works), but run under a sandboxed RuntimeClass (gVisor, Kata), so
 *   a container escape is contained by the runtime rather than landing on the node. The strongest mode on one node.
 * - "node": scheduled onto a separate, tainted runner node pool (nodeSelector + tolerations) and kept off the
 *   executor's node by pod anti-affinity. A compromised runner node never holds the executor's credentials or
 *   storage. It needs snapshot storage reachable from another node (ReadWriteMany), so it is refused with the shared
 *   ReadWriteOnce volume (fail closed) unless the operator provides cross-node storage.
 */
export type RunnerIsolation =
  | { mode: "colocated" }
  | { mode: "sandbox"; runtimeClass: string }
  | { mode: "node"; runtimeClass?: string; nodeSelector: Record<string, string>; tolerations?: object[] };

type PodBase = {
  namespace: string;
  runnerImage: string;
  serviceAccountName: string;
  /** Labels of the executor pod, for co-location (colocated/sandbox) or anti-affinity (node). */
  executorPodLabels: Record<string, string>;
  isolation: RunnerIsolation;
};

/** Thrown when runner isolation is missing or inconsistent, so the executor fails closed (M4). */
export class RunnerIsolationError extends Error {}

/**
 * Validates the isolation config and returns the pod-placement fragment. `sharesExecutorVolume` is true for pods that
 * mount the executor's ReadWriteOnce snapshot PVC (executions); such pods can't use "node" mode, which spans nodes.
 */
export function placement(isolation: RunnerIsolation | undefined, executorPodLabels: Record<string, string>, sharesExecutorVolume: boolean): Record<string, unknown> {
  if (!isolation || typeof isolation !== "object") throw new RunnerIsolationError("Runner isolation is not configured (chart value runner.isolation); refusing to build a runner Job");
  const coLocate = { podAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: executorPodLabels }, topologyKey: "kubernetes.io/hostname" }] } };
  if (isolation.mode === "colocated") return { affinity: coLocate };
  if (isolation.mode === "sandbox") {
    if (!isolation.runtimeClass) throw new RunnerIsolationError('Runner isolation mode "sandbox" needs a runtimeClass (e.g. gvisor or kata)');
    return { affinity: coLocate, runtimeClassName: isolation.runtimeClass };
  }
  if (isolation.mode === "node") {
    if (sharesExecutorVolume) throw new RunnerIsolationError('Runner isolation mode "node" needs snapshot storage reachable from another node (ReadWriteMany); the shared ReadWriteOnce volume cannot be used');
    if (!isolation.nodeSelector || Object.keys(isolation.nodeSelector).length === 0) throw new RunnerIsolationError('Runner isolation mode "node" needs a nodeSelector for the runner node pool');
    return {
      nodeSelector: isolation.nodeSelector,
      ...(isolation.tolerations && isolation.tolerations.length ? { tolerations: isolation.tolerations } : {}),
      ...(isolation.runtimeClass ? { runtimeClassName: isolation.runtimeClass } : {}),
      affinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: executorPodLabels }, topologyKey: "kubernetes.io/hostname" }] } },
    };
  }
  throw new RunnerIsolationError(`Unknown runner isolation mode ${JSON.stringify((isolation as { mode?: unknown }).mode)}`);
}

export type JobSpecInput = PodBase & {
  executionId: string;
  snapshotId: string;
  snapshotName: string;
  snapshotVersion: number;
  workflow: string;
  inputs: Record<string, string>;
  variables: Record<string, string>;
  /** From the snapshot's binding, never from the request. */
  secret?: { name: string; keys: string[] };
  network: NetworkMode;
  pvcName: string;
  snapshotSubPath: string;
  resources: { cpu: string; memory: string; scratch: string };
  maxMinutes: number;
  ttlSecondsAfterFinished: number;
};

export const jobName = (executionId: string) => `gha-emergency-${executionId}`;

const POD_SECURITY = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } };
const CONTAINER_SECURITY = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } };

function networkSpec(network: NetworkMode) {
  return {
    hostAliases: [{ ip: "127.0.0.1", hostnames: GITHUB_HOSTS }],
    ...(network === "isolated" ? { dnsPolicy: "None", dnsConfig: { nameservers: ["127.0.0.1"], searches: [], options: [{ name: "ndots", value: "1" }] } } : {}),
  };
}

export function buildJob(i: JobSpecInput) {
  // M4: fail closed before building anything if isolation is missing or invalid. Executions mount the shared RWO volume.
  const place = placement(i.isolation, i.executorPodLabels, true);
  const labels = {
    ...RUNNER_POD_LABELS,
    [NETWORK_LABEL]: i.network,
    [ROLE_LABEL]: "execution",
    [EXECUTION_LABEL]: i.executionId,
    "gha-emergency.github-actions-ui/snapshot": i.snapshotId.slice(0, 63),
  };
  const execution = { id: i.executionId, workflow: i.workflow, digest: i.snapshotId, inputs: i.inputs, variables: i.variables };
  const volumes: object[] = [
    { name: "snapshot", persistentVolumeClaim: { claimName: i.pvcName, readOnly: true } },
    { name: "work", emptyDir: { sizeLimit: i.resources.scratch } },
    { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
  ];
  const mounts: object[] = [
    { name: "snapshot", mountPath: "/snapshot", subPath: i.snapshotSubPath, readOnly: true },
    { name: "work", mountPath: "/work" },
    { name: "tmp", mountPath: "/tmp" },
  ];
  if (i.secret) {
    // Only the listed keys are projected; every other key of the Secret stays out of the pod.
    volumes.push({ name: "secrets", secret: { secretName: i.secret.name, defaultMode: 0o440, optional: false, items: i.secret.keys.map((key) => ({ key, path: key })) } });
    mounts.push({ name: "secrets", mountPath: "/secrets", readOnly: true });
  }
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName(i.executionId),
      namespace: i.namespace,
      labels,
      annotations: {
        "gha-emergency.github-actions-ui/workflow": i.workflow,
        "gha-emergency.github-actions-ui/snapshot-name": `${i.snapshotName} v${i.snapshotVersion}`,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: i.maxMinutes * 60 + 120,
      ttlSecondsAfterFinished: i.ttlSecondsAfterFinished,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: i.serviceAccountName,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...networkSpec(i.network),
          securityContext: POD_SECURITY,
          ...place,
          containers: [
            {
              name: RUNNER_CONTAINER,
              image: i.runnerImage,
              imagePullPolicy: "IfNotPresent",
              // Security review H3: the execute-only node copy makes the runner non-dumpable (runner/main.ts).
              command: [RUNNER_NODE, "--disable-sigusr1", "--disable-warning=ExperimentalWarning", "/app/deploy/emergency/runner/main.ts"],
              env: [
                { name: "GHA_EMERGENCY_EXECUTION", value: JSON.stringify(execution) },
                { name: "GHA_EMERGENCY_SNAPSHOT_DIR", value: "/snapshot" },
                { name: "GHA_EMERGENCY_WORK_DIR", value: "/work" },
                { name: "GHA_EMERGENCY_SECRETS_DIR", value: "/secrets" },
                { name: "GHA_EMERGENCY_MAX_MINUTES", value: String(i.maxMinutes) },
                { name: "GHA_EMERGENCY_NETWORK_PROBE", value: "github.com,api.github.com,codeload.github.com" },
              ],
              resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: i.resources.cpu, memory: i.resources.memory, "ephemeral-storage": i.resources.scratch } },
              securityContext: CONTAINER_SECURITY,
              volumeMounts: mounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

// ---- network canary ------------------------------------------------------------------------------------------------

export type CanaryTarget = { name: string; host: string; port: number };
/**
 * "probe-isolated" and "probe-egress" carry exactly the labels of execution pods in that mode, so the same
 * NetworkPolicies select them. "control" is selected by none of them: it shows the network itself works.
 */
export type CanaryRole = "probe-isolated" | "probe-egress" | "control";

export type CanarySpecInput = PodBase & { checkId: string; role: CanaryRole; targets: CanaryTarget[] };

export const canaryJobName = (checkId: string, role: CanaryRole) => `gha-emergency-canary-${checkId}-${role}`;
export const CANARY_CHECK_LABEL = "gha-emergency.github-actions-ui/network-check";

export function buildCanaryJob(i: CanarySpecInput) {
  const network: NetworkMode = i.role === "probe-egress" ? "egress" : "isolated";
  // Probes mirror an execution pod's placement; the control pod stays co-located. Canaries mount no shared volume,
  // so "node" mode is allowed for them (M4).
  const place = placement(i.isolation, i.executorPodLabels, false);
  const labels =
    i.role === "control"
      ? { "app.kubernetes.io/name": "gha-emergency-canary-control", "app.kubernetes.io/managed-by": "gha-emergency-executor", [ROLE_LABEL]: "canary-control", [CANARY_CHECK_LABEL]: i.checkId }
      : { ...RUNNER_POD_LABELS, [NETWORK_LABEL]: network, [ROLE_LABEL]: "canary-probe", [CANARY_CHECK_LABEL]: i.checkId };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: canaryJobName(i.checkId, i.role), namespace: i.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: i.serviceAccountName,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // The control keeps cluster DNS like any ordinary pod; probes get exactly an execution's network settings.
          ...(i.role === "control" ? {} : networkSpec(network)),
          securityContext: POD_SECURITY,
          ...(i.role === "control" ? { affinity: { podAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: i.executorPodLabels }, topologyKey: "kubernetes.io/hostname" }] } } } : place),
          containers: [
            {
              name: RUNNER_CONTAINER,
              image: i.runnerImage,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "--disable-warning=ExperimentalWarning", "/app/deploy/emergency/runner/canary.ts"],
              env: [{ name: "GHA_EMERGENCY_CANARY_TARGETS", value: JSON.stringify(i.targets) }],
              resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "200m", memory: "128Mi", "ephemeral-storage": "64Mi" } },
              securityContext: CONTAINER_SECURITY,
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: { sizeLimit: "16Mi" } }],
        },
      },
    },
  };
}
