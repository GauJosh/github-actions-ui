# gha-emergency chart

Emergency execution for GitHub Actions UI. It installs:
- an executor, which serves the UI and the emergency API and stores snapshots;
- the Role and service accounts its runner Jobs need.

It is separate from the read-only `gha-ui` chart, and optional.

Design, security model, supported features and run steps: `docs/EMERGENCY_EXECUTION.md`.

**Key values:**
- `executor.image` and `runner.image`: images built from `deploy/emergency/Dockerfile`. They must be available on the nodes, or in a registry reachable during a GitHub outage (not `ghcr.io`).
  - `runner.image.digest` is required (`sha256:…`, as the nodes' runtime knows the image). Runner Jobs use `repository@digest`, and the admission policy admits no other image (security review H4).
  - `executor.image.digest` is required too (`sha256:…`). The executor runs `repository@digest` with `IfNotPresent`, so a mutable tag can't change what the privileged component runs, or leave a stale cached image running (security review M7). The chart fails to install without both digests.
- **Admission policy** (always installed, security review H4): a ValidatingAdmissionPolicy and binding pin every Job in the namespace, and every pod a Job creates, to the runner's image, command, service account, security context, resources, volumes, environment and network labels. The executor proves the API server enforces it before each execution.
  - Needs Kubernetes 1.30 or later.
  - Both objects are cluster-scoped, so installing needs permission to create them.
  - Nothing else can create Jobs in the namespace, and a mutating webhook that injects sidecars or volumes into its pods (a service mesh, for example) makes them fail; exclude the namespace from such webhooks.
- `runner.resources`, `runner.maxMinutes`, `runner.maxConcurrent`, `runner.ttlSecondsAfterFinished`.
- `persistence.size` and `persistence.storageClassName`: snapshot storage. It is ReadWriteOnce, so runner pods are scheduled on the executor's node.
- `auth` (security review H2): sign-in with an OpenID Connect provider (`auth.oidc`), session lifetimes, the first administrators (`auth.initialAdministrators`, by issuer and subject), and break-glass accounts for provider outages (`auth.breakGlass.accounts`). The chart refuses to install without one sign-in method. The shared operator token no longer authorizes the API.
- `approval`: which executions wait for an approver (default: those that receive a Secret, or run in egress mode), separation of duties, and how long a request or approval lasts.
- `operatorToken.existingSecret`: the break-glass credentials Secret (one key per account; generated when empty).
- The executor contacts the identity provider over HTTPS on port 443, which its NetworkPolicy already allows; the provider must not depend on GitHub.
- `secretBindings`: which Secret, and which keys, executions of exact snapshot digests may receive (security review C1). Nothing is mounted without one.
- `network`: NetworkPolicies are always installed. Isolated executions run only after the executor's canary proves that the cluster enforces them (security review C2).
  - Use a network plugin that enforces NetworkPolicy (Calico, Cilium).
  - `allowEgressMode` enables a non-isolated egress mode.
- `clusterChecks`: install and upgrade fail unless the namespace is dedicated (labelled `gha-emergency.github-actions-ui/dedicated=true`) and restricted, holds no unrelated Secrets, and every bound Secret exists, is Opaque and holds its keys.
- `resourceQuota` and `limitRange` (security review L1): a ResourceQuota and LimitRange are installed into the dedicated namespace. The quota is the hard backstop behind the executor's concurrency check — even if that check races, the API server admits no more concurrent pods or CPU/memory than budgeted. It tracks **pods**, not Jobs, so finished Job pods (terminal) and Jobs lingering until their TTL never exhaust it. The pod cap is derived as `1 + runner.maxConcurrent + resourceQuota.extraPods`, so it always fits the workload; the CPU/memory caps have conservative defaults sized for the default executor plus `runner.maxConcurrent` runner pods plus canary headroom — **raise them if you raise `runner.resources` or `runner.maxConcurrent`**, or legitimate runner pods are refused (a clear admission error). The LimitRange's per-container max equals the runner cap, matching (never tightening) the admission policy (H4). Both are namespaced, so they affect only this namespace; the chart fails the install on an insufficient quota configuration.

**Install** into a dedicated namespace that enforces Pod Security `restricted`. The executor, runner and canary pods comply.

Install with no Secrets in the namespace. Once a snapshot is prepared, create its Secret and bind it to the snapshot's digest in the same sitting: the chart refuses any Secret that isn't bound.
