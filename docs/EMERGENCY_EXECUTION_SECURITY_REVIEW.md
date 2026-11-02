# Emergency execution — security review

**Reviewed:** 2026-10-30, the uncommitted MVP described in `docs/EMERGENCY_EXECUTION.md`. This is the source of truth for remediation.

**Method:**
- **Code:** read the implementation.
- **Cluster:** read-only queries against the local minikube deployment (`kubectl get`, `kubectl auth can-i`). No resources were changed.
- **Attacks, run locally only:**
  - a deliberately malicious snapshot, through the real runner entry point as PID 1, inside the runner image with no network;
  - forged uploads against a temporary store.
- **Probe scripts:** kept outside the repository, in the session scratchpad.

**Evidence labels:**
- **Demonstrated:** reproduced in this review or in earlier tests.
- **Code-confirmed:** verified by reading the code, not exercised.
- **Theoretical:** depends on the environment.

**Remediation status:**
- C1, C2, H1, H2, H3 and H4 were remediated afterwards and committed together as one checkpoint; none is deployed. M1–M7 and the low findings remain open. See "Remediation log" at the end.
- No proposal (K-1…K-11, Q-R1, Q-R2) is approved by this document.

---

## Critical

### C1. Any execution can mount any Secret in the namespace, and workflow code can read every key — Demonstrated

**Affected code:**
- `deploy/emergency/executor/api.ts:183`: `secretName` is checked for name syntax only.
- `deploy/emergency/executor/job-spec.ts`: the whole Secret is mounted.
- `deploy/emergency/runner/engine.ts:94`: every file is loaded.
- Step code runs as the same user and can read `/secrets/*` directly.

**Evidence:** the probe workflow listed `/secrets` and printed a key it never referenced (`OTHER_TEAM_TOKEN`), reversed, in the step log.

**Attack scenarios:**
- An operator runs a snapshot from a less-trusted repository with `prod-secrets`, and its code takes every key.
- An execution names `gha-emergency-operator`, which is mountable and in the same namespace. The code steals the operator token and gains full control of the executor.
- If the chart is installed into a shared namespace, every Secret there is exposed.

(Helm release Secrets are not mountable through the API, because their names contain dots, which the name check rejects.)

**Remediation:**
- Let administrators bind which Secrets each snapshot may use.
- Mount only the required keys (secret volume `items:`).
- Refuse the operator-token Secret and non-Opaque Secrets.
- Require a dedicated namespace.

### C2. Network isolation is not enforced — Demonstrated (minikube)

**Affected code:** `deploy/emergency/executor/job-spec.ts:94-95`. Isolation is name-based only (`hostAliases`, `dnsPolicy: None`). The chart's NetworkPolicy works only where the network plugin enforces it.

**Evidence:** on minikube with kindnet, a pod carrying the runner labels connected to `1.1.1.1:443`.

**Attack scenarios** — reachable by IP address:
- the internet, so the secrets from C1 can be exfiltrated;
- every in-cluster service. On this cluster that is `devops-genai` (including `ollama` and `rag-service`), Prometheus, Grafana, the Kubernetes dashboard, `gha-ui` and the executor;
- the kubelet;
- on AKS, the cloud metadata endpoint `169.254.169.254` and the node's managed identity (Theoretical here).

The Kubernetes API is reachable, but anonymous access is minimal: anonymous callers can't even run self-review (verified).

**"github-blocked" mode** keeps full cluster DNS, so everything except GitHub's hostnames resolves.

**Remediation:**
- Require a network plugin that enforces NetworkPolicy, and verify enforcement with a canary.
- Refuse isolated runs unless enforcement is proven.
- Block the metadata service and the API server explicitly.
- Show "GitHub unreachable" evidence only when isolation is enforced.

## High

### H1. Snapshot provenance and validation are client-asserted — Demonstrated

**Affected code:** `deploy/emergency/executor/store.ts:102,104` takes `source` and `executable` from the uploaded manifest.

**Evidence:**
- A snapshot whose honest validation had two blocking errors (`job-feature`, `github-token`) was uploaded with the errors stripped and with the forged source `acme/production-deploy@ffffffff`.
- The executor stored it as executable.
- Uploading under an existing name just creates the next version.

**Attack scenario:** a token holder uploads "release demo vN+1", claiming the production commit, and another operator runs it with production secrets.

**Remediation:**
- Re-run validation on the server from the packaged files.
- Sign snapshots at preparation, or prepare them server-side.
- Mark provenance as unverified in the UI.
- Add name ownership.

### H2. One shared operator token, with no identity, roles, approval or attribution — Code-confirmed

**Affected code:**
- `deploy/emergency/executor/api.ts` (`authorized`).
- `deploy/emergency/executor/server.ts:25`: the token is read once at startup.
- The chart keeps the token on uninstall and never rotates it.

**Attack scenario:** a leaked token, or any insider who has it, can upload snapshots, run them with any Secret (C1) and delete them, and the audit log can't attribute any of it.

**Remediation:**
- Single sign-on through an authenticating proxy, with the user recorded in every audit line.
- Separate roles for preparing, approving and executing, with two-person approval to execute.
- Token rotation.
- A durable audit sink.

### H3. Workflow code can forge or erase the runner's results — Demonstrated

**Affected code:**
- Steps run as the same user as the runner (PID 1), so they can write to `/proc/1/fd/1`.
- `src/emergency/events.ts:22` accepts any line that contains the event prefix.

**Evidence:**
- A forged "network: evil.example unreachable" event was accepted by the executor's own parser.
- With a file-backed stdout, the forged write also erased the genuine start and verification events.
- The pipe-backed stdout used in a pod was not tested.

**Attack scenario:** a malicious step fakes success or "GitHub unreachable" evidence, or hides failed steps, and so misleads recovery decisions.

**Remediation:**
- Run steps as a different user from the runner, or run the runner in a separate container.
- Authenticate events with a per-execution key that steps can't read.
- Cross-check reported results against the Job's exit code.

### H4. The executor can create Jobs with any pod spec, and the chart doesn't enforce namespace safety — Code-confirmed

**Affected code:**
- `charts/gha-emergency/templates/rbac.yaml:12` grants `create jobs`, and RBAC can't constrain the pod spec.
- The chart doesn't create or label the namespace.

**Attack scenario:** a compromised executor creates pods that use its own service account, mount any Secret, or (if the namespace isn't "restricted") run privileged with `hostPath`, which means taking over the node.

**Remediation:**
- A ValidatingAdmissionPolicy that pins executor-created Jobs to the runner image digest, service account, volumes and security context.
- Install and startup refuse a namespace that isn't dedicated and labelled "restricted".

## Medium

### M1. Command injection through step outputs and expression interpolation — Demonstrated

**Affected code:**
- `deploy/emergency/runner/engine.ts:492` honours `::set-output::` on any stdout line, and outputs are interpolated into later scripts.
- Inputs work the same way. The demo workflow has this pattern (`examples/emergency-demo/.github/workflows/release.yml:25`).

**Evidence:** an untrusted tool's output ran `INJECTED-COMMAND-RAN` in a later step.

**Remediation:**
- Drop stdout `set-output` (GitHub deprecated it).
- Warn at validation when `${{ }}` appears inside `run:`.
- Pass inputs through `env:` in the demo.

### M2. Secret masking is exact-match only — Demonstrated

**Evidence:** the base64 encoding of the signing key appeared in the log.

**Exposure:** logs are archived on the volume and visible to every operator. GitHub has the same limitation.

**Remediation:**
- Also mask common encodings.
- Restrict log access.
- Reduce exposure (C1).

### M3. Unauthenticated memory exhaustion — Code-confirmed (not tested, to avoid disrupting the deployment)

**Affected code:**
- `deploy/emergency/executor/server.ts:63-76` buffers up to 64 MB of any API request body before checking the token.
- The executor's memory limit is 512 MiB.
- Executor ingress accepts any pod (`charts/gha-emergency/templates/networkpolicy.yaml:28`).

**Remediation:**
- Authenticate before reading the body.
- Apply per-route limits before buffering.
- Limit connections.
- Restrict ingress.

### M4. Untrusted code is co-scheduled with the executor — Code-confirmed

**Affected code:** required pod affinity (`deploy/emergency/executor/job-spec.ts:98`), with only the RuntimeDefault seccomp profile.

**Attack scenario:** a container escape lands on the node that holds the executor's service-account token and all stored snapshots and logs.

**Remediation:**
- A separate, tainted node pool.
- A sandboxed runtime class (gVisor or Kata).
- Storage that doesn't need affinity.

### M5. The privileged executor serves the UI where users enter their GitHub token — Code-confirmed

**Attack scenario:** a compromised executor serves script that steals the GitHub token.

**Remediation:** serve the UI from a separate origin or deployment.

### M6. Results can be hidden by flooding the logs — Theoretical

**Cause:** the executor reads at most 16 MB of pod log, and kubelet log rotation drops older lines.

**Attack scenario:** a step pushes the verification and network events out of view.

**Remediation:**
- A separate event channel.
- A per-step cap on log volume.

### M7. Mutable image tags with `IfNotPresent` — Code-confirmed

**Remediation:** digest-pinned, signed images, verified at admission.

## Low and informational

- **L1:** no ResourceQuota or LimitRange, and the concurrency check races between check and create (`deploy/emergency/executor/api.ts:197`).
- **L2:** inputs and variables are stored and shown in plain text: in the Job's environment, execution records, the API and the UI.
- **L3:** internal Kubernetes error messages are returned to clients (`deploy/emergency/executor/api.ts:256`).
- **L4:** no TLS. Acceptable over port-forward; required before any Ingress.
- **L5:** concurrent uploads under the same name can produce duplicate version numbers.
- **Info:** confining `working-directory` and action entry points isn't a security boundary; the pod is.

## Controls verified to hold

- **RBAC:** the executor can't read Secrets or create pods directly. The runner has no permissions (`kubectl auth can-i`).
- **Runner pod:**
  - no service-account token;
  - Pod Security "restricted" admitted;
  - snapshot mounted read-only (in the admitted spec).
- **Integrity:**
  - tampered, incomplete and path-traversal uploads are rejected (unit tests);
  - changes on the volume are detected;
  - the runner re-verifies the requested digest (runner check).
- **API:** constant-time token comparison; no CORS.
- **Secret values** never appeared in Job specs, API responses or the page (tests).
- **Rendering and parsing:** React escapes log text; YAML alias count is limited.

## Remediation priority

**Must fix before production:**
1. **C1:** bind Secrets to snapshots; mount only required keys; refuse the operator Secret; require a dedicated namespace.
2. **C2:** require and verify NetworkPolicy enforcement; block metadata and API-server addresses; otherwise refuse isolated mode.
3. **H4:** admission policy pinning executor-created Jobs; refuse namespaces that aren't "restricted".
4. **H2:** per-user authentication, roles and approval; attributed, durable audit; token rotation.
5. **H1:** server-side re-validation and signed provenance; name ownership.
6. **H3:** separate the runner's and steps' users or containers; authenticate events.
7. **M3:** authenticate before reading bodies; body and connection limits; restrict ingress.
8. **M1:** remove stdout `set-output`; warn on interpolation inside `run:`; fix the demo workflow.
9. **M4:** a separate node pool and a sandboxed runtime.

**Should fix soon:**
- **M2:** mask encodings; restrict log access.
- **M5:** a separate UI origin.
- **M6:** an event channel and log caps.
- **M7:** digest-pinned, signed images.

**Later:** the Low items.

---

## Remediation log

### C1 — remediated 2026-10-30 (committed in the checkpoint through H2, not deployed)

**Changes:**
- **Secret bindings** (`deploy/emergency/executor/bindings.ts`, chart `secretBindings`, ConfigMap `templates/bindings.yaml`).
  - Set by a cluster administrator. Each names one Secret, its permitted keys, and the exact snapshot **digests** it serves.
  - Read for every execution, so changes apply without a restart.
  - Invalid bindings void all bindings (fail closed). Ambiguous bindings are refused.
- **API** (`api.ts`):
  - `secretName` in a request is refused; the Secret comes only from the binding.
  - A snapshot without a binding for its digest, or whose binding lacks a required key, is refused.
  - The operator-token Secret is refused at three points: chart render, bindings loader and API.
- **Job** (`job-spec.ts`): the secret volume projects only the keys the snapshot requires (`items`).
- **Runner** (`engine.ts`): refuses to start when any key the snapshot doesn't require is mounted. It reports key names, never values.
- **Chart install and upgrade checks** (`templates/cluster-checks.yaml`, using Helm `lookup`):
  - the namespace must be labelled `gha-emergency.github-actions-ui/dedicated=true` and enforce Pod Security "restricted";
  - it may hold no Secrets other than the operator token, this release's Helm records and bound Secrets;
  - each bound Secret must exist, be Opaque and contain its keys.
- **UI:** the free-text Secret field is gone. The page shows the binding, or "Not authorized" with the digest to bind.

**Attack tests:**

| Attack | Before | After |
|---|---|---|
| Step reads an unreferenced key (`OTHER_TEAM_TOKEN`) from `/secrets`; the review's PID-1 probe in the runner image | Leaked (printed reversed) | Runner refuses before any step: "Secret keys this snapshot does not require are mounted (OTHER_TEAM_TOKEN)". Nothing leaked. In Kubernetes the key is no longer even mounted (`items`) |
| Execution names another Secret, or the operator Secret | Accepted (name syntax only) | 422 "secretName can't be chosen"; no Job created |
| Look-alike snapshot (same name and claimed repository, different content) asks for the bound Secret | n/a (no binding concept) | 422: the binding is for another digest |
| Bound Secret holds extra keys | Whole Secret mounted | Only the required keys projected |
| Binding names the operator Secret | n/a | Refused by the chart (`helm template` fails), the bindings loader and the API |
| Install into an undedicated namespace (server-side dry run against the live minikube) | Allowed | Refused: "Namespace gha-emergency must be dedicated to emergency execution…". No change was made to the release (still revision 2) |

**Regression tests:**
- `tests/unit/emergency-executor.test.ts` ("security review C1"): 7 tests.
- `tools/emergency/runner-check.ts` scenario "a mounted Secret key the snapshot doesn't require stops the run". It passed in the runner image (5 of 5 scenarios).
- `tests/e2e/emergency.spec.ts`: an unbound snapshot shows "Not authorized", and its start button is disabled.

**What remains:**
- **H1:** bindings are as strong as digest review. Upload provenance is still client-asserted.
- **M2:** a *required* secret can still be leaked in encoded form by code that receives it. Shown again after the fix: its base64 appeared.
- **Drift after install.** The chart checks run only at install and upgrade. A Secret created later is never mountable through the executor, but anyone with Secret or Job access in the namespace bypasses the executor entirely (H4).

### C2 — remediated 2026-10-30 (committed in the checkpoint through H2, not deployed)

**Changes:**
- **Policies** (`templates/networkpolicy.yaml`, always rendered):
  - a baseline deny-all ingress and egress for every runner pod;
  - an opt-in egress policy for `network=egress` pods: `0.0.0.0/0` except private, CGNAT, link-local (metadata) and loopback ranges, plus cluster DNS. The API server, nodes and in-cluster services fall in the excluded ranges.
- **Canary** (`deploy/emergency/runner/canary.ts`; `deploy/emergency/executor/network-check.ts`; `buildCanaryJob` in `job-spec.ts`):
  - A probe pod carries exactly an isolated execution's labels, network settings and pod security. It targets an external IP, the Kubernetes API (the executor's `KUBERNETES_SERVICE_HOST`), the metadata address and an internal service (the executor's Service, by IP).
  - A control pod, outside every runner policy, targets the internal service.
  - **"enforced"** only if the control connects and the probe reaches nothing.
  - **"not-enforced"** if the probe reaches anything.
  - **"unverified"** otherwise: the control failed, a canary didn't finish, or its output was unreadable.
  - With egress mode enabled, an egress probe must reach neither the API, the metadata address nor the internal service.
- **Gate** (`api.ts`):
  - It runs at executor startup and before each execution when older than `network.canary.maxAgeSeconds` (900).
  - Isolated executions are refused (409) unless the verdict is "enforced", and the verdict is recorded on the execution.
  - `GET` and `POST network-check` are added.
- **Modes:**
  - `github-blocked` is refused with an explanation.
  - `egress` is refused unless `network.allowEgressMode` is set and its canary passes.
  - Egress is labelled "NOT isolated" in the UI and execution records.
- **Defense in depth only:** `hostAliases` and DNS removal stay, but are no longer described as the boundary. The runner's own hostname probe is labelled "not proof".

**Attack tests:**

| Attack | Before | After |
|---|---|---|
| Isolated runner reaches a raw IP (`1.1.1.1:443`), the API server, metadata and internal services on a non-enforcing cluster (kindnet), simulated in unit tests | Execution ran (raw-IP egress demonstrated on minikube) | Canary verdict "not-enforced", naming every reached target; isolated execution refused (409); no Job created |
| A single leak (metadata only) | n/a | "not-enforced" |
| Broken network (control can't connect) | n/a | "unverified"; refused, never "enforced" |
| Canary that hangs or prints garbage | n/a | "unverified"; refused |
| `github-blocked` mode (cluster DNS, everything but GitHub's names reachable) | Allowed and described as blocking GitHub | 422 "was removed … was not isolated" |
| Egress mode on a cluster that leaks the API server | n/a | 409 with the leaking target |

The canary script's detection was checked in the runner image:
- **No network:** every target unreachable (`ENETUNREACH`).
- **Podman bridge network:** `1.1.1.1:443` **reachable**, which is exactly what makes the executor refuse.

**Regression tests:**
- `tests/unit/emergency-executor.test.ts`: "network isolation gate" (5 tests) and "the network canary" (7 tests).
- `tests/e2e/emergency.spec.ts`: unproven isolation is shown, and executions are refused.

**What remains:**
- **Positive run on an enforcing cluster:** done. See "Live validation on gha-sec" below.
- **Canary coverage.** The canary proves the policy for one node, the executor's, where runners are pinned. It tests one external IP, the API server ClusterIP and the metadata IP. It doesn't enumerate every address.
- **Executor egress** (ports 443/6443/8443 to any address) is unchanged; it's part of H4 and M3.
- **Policy changes between checks.** A policy removed after a check is caught at the next check, up to 15 minutes later.

### Live validation on `gha-sec` (Calico), 2026-10-30

**Environment:**
- A separate minikube profile, `gha-sec`: Podman driver, CRI-O, Kubernetes v1.35.0, Calico, 2 CPUs, 2,560 MB.
- `--keep-context` was used; kubectl's context stayed `minikube` throughout.
- Images tagged `:c1c2` were loaded into `gha-sec` only.
- **Credentials:** synthetic, randomly generated (`DEMO_SIGNING_KEY` and a decoy `OTHER_TEAM_TOKEN` in the same Secret). Never printed; the local copies were deleted after the tests.
- **The existing `minikube` profile was not modified.** It stayed at release revision 2, with its original policies and `:local` images.

**Startup:**
- The first two `minikube start` attempts failed, which is the Podman driver's flakiness, not this code:
  - first, the Podman socket connection was "forcibly closed";
  - second, a `gha-sec` volume left over from the first attempt.
- Only `gha-sec` artifacts were removed between attempts (`minikube delete -p gha-sec`).
- The existing cluster stayed up. Its four crash-looping pods (`rag-service`, `grafana`) predate this work: 4,000–8,800 restarts.

| # | Check | Result |
|---|---|---|
| 1 | Calico health | `calico-node` and `calico-kube-controllers` ready; 22 Calico CRDs; IP pool 10.244.0.0/16 |
| 2 | Canary verdict | **enforced**. (The very first startup check was "unverified", a race described below, now fixed.) |
| 3 | Runner pods blocked: external IP, Kubernetes API, metadata, internal service | Canary probe: all 4 blocked (time-outs). Independent comparison: a pod with the runner labels was blocked from **10 of 10** targets; an otherwise identical pod without them reached **9 of 10**. Targets: 1.1.1.1:443, 8.8.8.8:53, API ClusterIP 10.96.0.1:443, API on the node 192.168.58.2:8443, kubelet :10250, executor Service and pod IP, cluster DNS Service and CoreDNS pod. The exception is metadata 169.254.169.254, unreachable from both pods: **metadata blocking is not provable on minikube** |
| 4 | Control reaches its service | Yes: TCP connection to the executor Service established |
| 5 | Unrelated Secret keys | From inside a real execution of an attack snapshot: only `DEMO_SIGNING_KEY` was mounted, and `OTHER_TEAM_TOKEN` was "not mounted" though it is in the same Secret. The admitted Job projects `items: [DEMO_SIGNING_KEY]` only. Neither value appeared in the results, raw or reversed |
| 5a | Direct-IP attack from a real execution | All 8 targets blocked. `github.com` resolves only to 127.0.0.1; `example.com` doesn't resolve |
| 5b | API refusals before binding | Unbound snapshot, a named operator Secret, a named `demo-secrets`: all 422; no Job created |
| 5c | Install guards (server-side dry runs) | Binding the operator Secret refused; an unrelated Secret in the namespace refused; release revision unchanged |
| 6 | Demo snapshot runs | Live browser test phase 2 passed: 5 jobs in order, success, isolation recorded as verified by the canary, no secret value on the page |
| 7 | Refusal when enforcement can't be proven | Runner deny-all policy deleted in `gha-sec` → forced check "not-enforced" (reached external-ip, kubernetes-api, internal-service) → execution **refused (409)**, no Job created. Policy restored with `helm upgrade` → "enforced" again |

**Found and fixed during the live run:**
- **Verdict caching and startup race.** The startup check ran before the executor's Service had a ready endpoint, so the control was refused ("unverified"). That verdict was then cached for 15 minutes, which would have refused every execution for that long.
  - Fix: only an "enforced" verdict is reused for the full age; others are reused for 30 seconds. The first check is delayed 20 seconds.
  - Regression test: "reuses a failed result only briefly".
  - Re-deployed to `gha-sec`: the startup check reached "enforced" on its own.
- **Impossible documented order.** The docs said to create the Secret before installing. The dedicated-namespace check (correctly) refuses any unbound Secret, and a binding needs a digest that exists only after preparation.
  - Corrected order: install with no Secrets, prepare, then create and bind the Secret.
  - The check itself was not weakened.
- **Live browser test split in two phases** (prepare, then run a bound digest), for the same reason.

**Still not shown:**
- metadata blocking on a real cloud;
- multi-node clusters;
- other network plugins (Cilium);
- policy tampering between checks (detected at most 15 minutes later);
- the open findings H1–H4 and M1–M7.

### H1 — remediated 2026-10-30 (committed in the checkpoint through H2, not deployed)

**Two separate concepts:**
- **Content integrity** is proven offline by the executor and runner.
- **Provenance** (is that content the claimed commit of the claimed repository on GitHub?) can only be answered by GitHub. It is checked live in the browser, shown as verified, failed or unverified, and never stored by or trusted by the executor.

**Changes:**
- **Git object IDs** (`src/emergency/git-objects.ts`). Each file records the Git blob ID GitHub reported for it. Each root records its Git tree ID, and whether it is complete (every file of the tree packaged, no symlinks or submodules). The tree-ID computation is checked against the `git` binary.
- **Server-side validation** (`src/emergency/revalidate.ts`). The same resolver is re-run over the packaged files alone. An upload is refused (422 `manifest-mismatch`) if its roots, workflows, actions, requirements, files or totals differ from what the files produce, or if it under-reports errors.
  - **Executability** is the executor's verdict: its own errors, plus any the uploader declared, which can only make it stricter.
  - **Content integrity per root:** `tree-verified` (a complete root's tree ID recomputed from the content), `blobs-verified` (a partial root), or `unverified` (a snapshot from before H1).
- **Storage** (`store.ts`): the record now holds the executor's `validation` and `integrity`. Snapshots stored before H1 are validated on first use, and the result is kept in `validations/<digest>.json`.
- **Executions** are gated on the executor's verdict (`api.ts`), no longer on the manifest's self-reported diagnostics.
- **The runner** re-runs the validation from its mounted files before any step (defense in depth against a compromised executor).
- **Name ownership:** a later version of a name must claim the same repository as its first version (422 `name-owned`). Secret bindings name exact digests (C1), so **a new version never inherits authorization**.
- **UI:**
  - the validation shown is the executor's;
  - the source is labelled "claimed by the uploader";
  - "Content integrity (checked by the executor, offline)" is a separate section;
  - "Provenance on GitHub" starts as "not checked — unverified" and has a **Check against GitHub** button (`src/emergency/provenance.ts`: `GET /git/commits/{sha}`, plus `GET /git/trees/{sha}` for partial roots).
- **Fixture GitHub** now reports real Git tree IDs and serves `GET /git/commits/{sha}`.

**Attack tests:**

| Attack | Before | After |
|---|---|---|
| The review's forgery: errors stripped and `acme/production-deploy@ffff…` claimed | Stored as executable | 422 `manifest-mismatch` ("could not rebuild", "under-reports validation errors"); nothing stored |
| Errors stripped only | Stored as executable | 422 "under-reports validation errors". Written straight to storage: the runner refuses before any job |
| Added or removed secret requirement; renamed job; changed action type; changed root ref; changed totals | Accepted | Mismatch, not executable |
| Altered file | sha256 caught it | Still caught; with a recomputed sha256, the **Git blob ID** catches it |
| Altered file with a forged blob ID | n/a | The **Git tree ID** of the complete root doesn't match: mismatch |
| Wrong or invalid Git IDs | n/a | Refused structurally, or a mismatch |
| Claimed commit whose GitHub tree differs; commit missing; forged repository | Not checkable | Provenance **failed** (shown in the UI) |
| Partial root with one file differing from GitHub | n/a | Provenance **failed**, naming the file |
| Another repository adding a version under an existing name | Got the next version | 422 `name-owned` |
| A new version of a bound snapshot | n/a | Gets no Secret (binding is by digest) |

**Regression evidence:**
- **The real s16 snapshot** (`73b2a989…`, prepared live before H1, copied read-only from `gha-sec`): it re-validates with no problems and no mismatches, as executable, with integrity `unverified` (it predates Git IDs). Checked both on the host and inside the runner image.
- **Tests:**
  - `src/emergency/git-objects.test.ts` (2, one against the `git` binary);
  - `revalidate.test.ts` (9);
  - `provenance.test.ts` (6);
  - "security review H1" in `tests/unit/emergency-executor.test.ts` (6);
  - the runner scenario "a forged manifest written straight to storage is refused";
  - the browser test checks integrity, the "unverified" default, and a **verified** provenance check.

**What remains:**
- **Provenance is checked, not enforced.** The executor still runs a content-verified snapshot whose provenance nobody checked. Requiring a recorded provenance attestation needs trusted identities (H2): a browser's claim can't be trusted as-is.
- **Trusting GitHub:** commit-to-tree checks trust GitHub's API and SHA-1 Git IDs.
- **Partial roots and old snapshots:** roots packaged partially (supporting-file prefixes, symlinks, submodules) get blob-level integrity only. Snapshots from before H1 have none.
- **Name ownership** is anchored to the *claimed* repository of a name's first version, and doesn't identify uploaders (H2).

### H3 — remediated 2026-10-30 (committed in the checkpoint through H2, not deployed)

**Root cause:**
- Steps ran as the runner's user, and the runner (PID 1) was an ordinary dumpable process, so any step could write to `/proc/1/fd/1` (the event channel) and read `/proc/1/environ`.
- The executor accepted any line *containing* the event prefix, with no authentication.
- A run's result was whatever the log said.

**Reproduced before the fix** (the attack workflow below, against the H1 runner image):
- writing the runner's stdout and stderr, listing its files, and reading its environment and memory map were all **allowed**;
- the old parser accepted 2 forged `execution-end` events, and **reported success for a failing run**;
- the signals the workflow sent killed the runner (exit 140).

**Changes:**
- **Runner out of the workflow's reach** (`runner/main.ts`, Dockerfile, `job-spec.ts`):
  - the runner starts from an execute-only, root-owned copy of node (`/usr/local/libexec/gha-emergency-runner-node`, mode 0111), which makes it non-dumpable;
  - it runs as PID 1 with `--disable-sigusr1`;
  - it refuses to start unless its `/proc` entries are root-owned.
  - No user switching and no capabilities: pod security is unchanged.
- **Authenticated, chained events** (`src/emergency/event-stream.ts`, `runner/event-signer.ts`):
  - a per-execution 32-byte key, generated by the executor and passed only in the runner's Job environment;
  - removed from the runner's environment at start; steps get their own minimal environment;
  - each line is `prefix <HMAC-SHA256(key, previous MAC + json)> <json with seq>`.
- **Result derivation** (`judgeExecution`):
  - only events up to the first unauthentic line are believed;
  - a finished run needs the authentic final event;
  - the reported result must match the runner container's exit code (archived with the log);
  - otherwise the result is **error**.
  - Executions from before H3 (no key) are shown as unverifiable.
- **Untrusted text** (`engine.ts`):
  - everything emitted from workflow-controlled text is masked, then sanitized (control characters, ANSI escapes, bidirectional and invisible characters escaped);
  - data passed between steps and jobs is unchanged;
  - annotations are tagged `source: "workflow"`.
- **UI:**
  - "Runner's events: authenticated (N events, complete)", or FAILED, or not verifiable;
  - the runner exit code;
  - every log line labelled `runner`, `out` or `err` in a gutter the workflow's text can't fill;
  - workflow annotations labelled as such.
- **Removed** `parseEventLine`, the unauthenticated "contains the prefix" parser.

**Attack tests:**

| Test | Where | Result |
|---|---|---|
| A hostile workflow through the real entrypoint (PID 1, execute-only node, uid 1000, read-only, no capabilities, no network) | `tools/emergency/runner-attack-check.ts`, runner image | 26/26 PASS |
| Writes to `/proc/1/fd/1` and `fd/2`; reads of its fds, environment, memory map and memory; ptrace attach; the key in the step's environment | same | all **denied** |
| Signals TERM, INT, HUP, USR1, USR2, STOP and KILL to PID 1 | same | runner unaffected; the stream is complete |
| Fake `execution-end` and `job-end` lines, and fake MACs, printed to stdout and stderr, in a `post:` step and in a composite's failing step | same | kept as log data; the result is **failure** (the composite's inner step recorded with exit 5; the post step recorded) |
| Escape sequences, `\r` and RLO in output | same | shown escaped |
| The real log with an event removed, an event edited to success, a fake success appended, the stream cut, or the result edited to success; the real log with exit code 0 | same, plus `event-stream.test.ts` | all **error** |
| Unauthenticated lines; fake MACs; events signed with another execution's key; reordered events; a stream missing its start; exit-code mismatch, also after the Job is gone; key never in API responses or the audit log; legacy executions | "security review H3" in `tests/unit/emergency-executor.test.ts` (8), `event-stream.test.ts` (7), a Job spec test | pass |
| Negative control: the H3 image started with the ordinary readable node | container | the runner **refuses** (exit 2) |

**Regression evidence:**
- **s16** (`73b2a989…`, outcome=pass) runs through the real entrypoint:
  - **success**, exit 0, authenticated stream;
  - composite inner steps 1 and 2 and the steps after them all succeed.
- **The runner check:** 6/6 (C1, H1, tamper and failure scenarios).
- **Browser tests** check the authenticated-stream status and the log-source labels.

**What remains:**
- **Same user, kernel-enforced.** The protection is the kernel's non-dumpable rule. A host with `fs.suid_dumpable=1` would defeat it, so the runner refuses to start. A kernel bug in that rule would defeat it too. A separate user for steps would add a second boundary, but needs privileges the restricted pod forbids.
- **Where the key lives.** The key is visible to anyone who can read the Job or pod spec in the namespace. Those principals can already create Jobs (H4).
- **What it can't prevent:** a workflow can still disrupt its own run (exhaust memory or disk, hang until the deadline), which is reported as an error or failure, never success. Its own output, outputs and annotations are still whatever it chooses: they are labelled, not verified.
- **Log rotation.** A log larger than the kubelet's rotation size loses its beginning and is reported as an error, where it used to be read silently in part.

### H4 — remediated 2026-11-02 (committed in the checkpoint through H2, not deployed)

**Root cause:**
- The executor's Role grants `create jobs`. RBAC authorizes the verb and the resource, never the Job's contents, so anything holding the executor's token can create any pod spec in the namespace.
- The only thing that shaped runner Jobs was the executor's own builder, `job-spec.ts`.
- Pod Security "restricted" applies to pods only, and only to the settings it knows about (privilege, host namespaces, hostPath, capabilities, seccomp, root). It doesn't cover Secrets, service-account tokens, images, sidecars, labels or resources.

**Reproduced before the fix** (`tools/emergency/admission-check.ts --reproduce`, with the policy's binding removed, as the executor's service account, on Kubernetes 1.35.0 with a Job controller):
- all **48 of 48** malicious Jobs were **accepted**;
- Pod Security "restricted" then admitted the pods of **36** of them, including:
  - the operator-token Secret mounted, any key of the bound Secret, and the bound Secret for a snapshot it isn't bound to;
  - Secrets as environment variables or `envFrom`;
  - a service-account token (automounted, projected, or the executor's own account);
  - another image, or the runner's own repository by mutable tag with `Always`;
  - sidecars and init containers;
  - another command, `NODE_OPTIONS`, exec probes;
  - no runner labels, which escapes the deny-all NetworkPolicy (C2);
  - unlimited resources, a GPU, a memory-backed or unbounded emptyDir, a writable snapshot volume or another claim;
  - `nodeName`, tolerating every taint;
  - parallelism 20 (bypassing `maxConcurrent`), retries, no deadline.
- Pod Security stopped the other 12: privileged, hostPath, host network, PID and IPC, privilege escalation, missing security contexts, root, capabilities and seccomp. A runtime class was also refused, because none existed.

**Changes:**
- **An admission policy in the API server** (`charts/gha-emergency/templates/admission-policy.yaml`): a ValidatingAdmissionPolicy (`failurePolicy: Fail`) and a binding (`Deny`) for the release namespace. It is native Kubernetes, with no webhook or extra component.
  - **What it checks.** Every Job created or changed there, by anyone, and every pod a Job owns, checked again after mutating admission. Each must be one of the shapes `job-spec.ts` builds, an execution or a network canary:
    - the runner image by digest with `IfNotPresent`;
    - one container, no init or ephemeral containers, the exact command, no arguments, hooks, probes or ports;
    - the runner service account without a token;
    - no host namespaces;
    - non-root, RuntimeDefault seccomp, no privilege escalation, read-only root filesystem, all capabilities dropped, no SELinux, Windows, AppArmor or sysctl overrides;
    - cpu, memory and ephemeral-storage limits within the chart's values, and no other resources;
    - size-limited emptyDirs, the snapshot read-only at one digest's directory, and Secret keys that `secretBindings` give that digest. The C1 binding is now enforced by Kubernetes too;
    - literal environment values from the runner's own variable list;
    - the runner's NetworkPolicy labels, in an enabled network mode (C2);
    - no `nodeName`, node selectors, extra tolerations, runtime or priority classes;
    - backoffLimit 0, one pod, and a bounded deadline;
    - and only in a namespace labelled dedicated and Pod Security "restricted".
  - **Values** (image, service account, claim, bindings, limits, deadline, egress mode) are rendered from the chart's values, so the policy can't be changed through anything the executor can write.
- **The runner image by digest.** `runner.image.digest` is required (the chart fails without it), and the executor refuses to start with a runner image that isn't `repository@sha256:…`. This also addresses M7 for the runner image.
- **The executor proves enforcement** (`deploy/emergency/executor/admission-check.ts`): two server-side dry runs, with no new permission (dry runs need `create jobs`, which it already has):
  - a canary Job with a hostPath volume must be denied by this policy;
  - the same Job without it must be accepted.
  - Executions are refused unless both hold. The result is reused for 15 minutes (30 seconds if not proven) and shown at `GET api/emergency/admission-check`.
- **Kubernetes 1.30 or later**: the chart's `kubeVersion`, and an install check that the API server serves `admissionregistration.k8s.io/v1` ValidatingAdmissionPolicy.

**Attacks, against a real API server** (`tools/emergency/admission-check.ts`, as the executor's service account via impersonation; the legitimate Jobs come from the real builders, configured from the installed executor's environment):

| Malicious Job | 1.35.0 | 1.30.14 |
|---|---|---|
| Privileged container; privilege escalation | Refused | Refused |
| hostPath mount | Refused | Refused |
| Host network, host PID, host IPC | Refused | Refused |
| Operator-token Secret mounted; whole bound Secret; a key it doesn't grant; for an unbound snapshot | Refused | Refused |
| Secret environment variable; Secret `envFrom` | Refused | Refused |
| Service-account token (automount; projected volume); the executor's account | Refused | Refused |
| Another image by digest; the runner's repository by mutable tag; pull policy `Always` | Refused | Refused |
| Sidecar; init container | Refused | Refused |
| Missing pod or container securityContext; root; writable root; capability added or not dropped; seccomp Unconfined | Refused | Refused |
| Excessive requests and limits; no limits; a GPU | Refused | Refused |
| Unbounded or memory-backed emptyDir; writable snapshot; whole snapshot volume; another claim; ConfigMap volume | Refused | Refused |
| Another command; extra arguments; `NODE_OPTIONS`; exec probe | Refused | Refused |
| No runner labels; egress label while egress is off | Refused | Refused |
| `nodeName`; tolerate every taint; runtime class | Refused | Refused |
| Parallelism 20; retries; no deadline | Refused | Refused |
| Canary with the snapshot mounted; canary control with a Secret | Refused | Refused |
| A cluster administrator's privileged Job | Refused | Refused |
| A Job-owned pod with an injected sidecar that Pod Security allows | Refused | not run (no Job controller) |

Every refusal names this policy, and no refused Job was stored.

**Legitimate Jobs accepted:** an isolated execution, an execution with its bound Secret, and the canary probe and control, on both versions. On 1.35.0 the Job controller's pod for an execution was admitted too (policy and Pod Security restricted).

**Unchanged RBAC:** the executor still can't create Jobs in another namespace, update or patch its Jobs, or create pods directly (all refused, 403).

**Installed is not enforced** (negative controls):
- With the namespace's dedicated label removed, a legitimate Job is refused, and the executor's check isn't "enforced".
- With the binding removed, the privileged Job is accepted (dry run): the policy, not RBAC or Pod Security, was refusing it. The executor's check reports "not-enforced".
- With the binding restored, it reports "enforced" again.

**Totals:** 66/66 on 1.35.0 (with the Job controller), 64/64 on 1.30.14.

**Regression evidence:**
- **Unit tests:** 601 passed, 1 skipped. New tests:
  - executions are refused unless enforced, before any canary or Job;
  - the check runs before every execution;
  - the two probes differ only by the hostPath volume;
  - "enforced", "not-enforced" and "unverified" are derived as described, and nothing is created for real;
  - results are cached as described.
- **The runner check:** 6/6 (C1, H1, tamper and failure).
- **The H3 attack check:** all PASS, including s16 through the real entrypoint (success, exit 0, authenticated stream).
- **Other checks:**
  - the executor image builds and loads the new modules;
  - it refuses a runner image by tag at startup;
  - emergency browser tests: 3 passed, 2 skipped (live);
  - tsc and eslint are clean.
- **Helm:**
  - install succeeds against both API servers, and an upgrade (adding a binding) against 1.35.0;
  - rendering fails without a digest, and for Kubernetes 1.29.

**What remains:**
- **Not deployed.** Neither minikube profile has the policy, and the `gha-sec` images are still pre-H1. The tested API servers had no kubelet, so the digest reference was never pulled on a node. On minikube (CRI-O, images loaded from an archive), confirm the node knows the digest before relying on it (`crictl inspecti`, see `docs/EMERGENCY_EXECUTION.md` §10).
- **Cluster administrators** can delete or edit the policy or binding. The executor would then refuse executions within 15 minutes (its next check), not instantly.
- **The policy's shape is duplicated** from `job-spec.ts` (commands, environment names). The admission check tool catches drift, but only when it is run.
- **Mutating webhooks** that add containers, volumes or environment to pods (a service mesh, AKS add-ons, Azure Policy mutations) make runner pods fail admission. Exclude the namespace from them. On AKS, ValidatingAdmissionPolicy is available from Kubernetes 1.30, and Azure Policy (Gatekeeper) may add constraints of its own. Not tested on AKS.
- **Inside the allowed shape** the executor still decides everything: which snapshot, inputs and variables an execution gets, which bound Secret keys, and the event key. A compromised executor can run any stored snapshot, with the Secret keys bound to it. That is H2's territory (who may ask the executor).
- **The canary control pod** has ordinary network access by design, but it can only run the canary script, which opens TCP connections to the targets it is given.
- **The event key (H3)** is still readable by anyone who can read Jobs or pods in the namespace.
- **ResourceQuota (L1)** is still absent. The policy bounds each Job (one pod, limits), but not their number.

### H2 — remediated 2026-11-02 (committed in the checkpoint through H2, not deployed)

**Before** (every route but health checked one bearer token, the same for everyone):

| Endpoint | Authentication | Authorization | Attribution |
|---|---|---|---|
| `GET health` | none | none | — |
| snapshots: list, upload, read, verify, delete | shared token | none (anyone with the token) | none |
| executions: list, start, read (logs), stop | shared token | none | none |
| network-check, admission-check | shared token | none | none |
| Secret bindings | Helm values only | cluster administrators | none |

- **Snapshot ownership** was the claimed repository's name, not a person.
- **No approval** existed, and the audit lines named no one.
- **The H3 event key** sat in the Job's environment, readable by anyone able to read Jobs or pods in the namespace.

**Authentication** (`deploy/emergency/executor/auth/`):
- **OpenID Connect sign-in** (`oidc.ts`, `jwt.ts`): the authorization code flow with PKCE (S256), state and nonce, run by the executor; discovery and JWKS from the configured issuer, over HTTPS only.
  - **ID token checks:** signature against the issuer's published key (by kid, matching key type, alg and use); asymmetric algorithms from an allow list (never `none` or HMAC); issuer, audience, authorized party, expiry, issued-at, not-before, maximum age and nonce.
  - **Login CSRF:** a short-lived cookie binds the pending sign-in to the browser. Codes and pending sign-ins are single-use, and the return location is restricted to the emergency view.
  - **Abstraction:** `IdentityProvider`, with OIDC its only implementation. `tools/emergency/dev-oidc.ts` is a local development provider, also used by the tests.
- **Sessions** (`store.ts`): 32 random bytes, a `__Host-` cookie, HttpOnly, Secure, SameSite=Strict, stored as a hash only.
  - **Limits:** 8 hours absolute, 1 hour idle.
  - **Revocation:** sign-out, an administrator's revocation, and disabling the user all take effect on the next request.
  - **CSRF:** every API call needs `X-GHA-Emergency: 1`, and a bearer token is refused.
- **Break-glass** (off by default): named accounts, each with its own credential (a key of the former operator-token Secret).
  - Roles are pinned and never administrator.
  - Each sign-in needs a reason, lasts 60 minutes, and repeated failures lock the account out.

**Authorization:**
- **Roles** (`roles.ts`): viewer, operator, approver and administrator, with an explicit permission list. Every route names its permission (`api.ts` header); visibility and ownership checks follow it.
- **Where roles come from:** the executor's records only, never token claims. Administrators change others' roles, never their own; `auth.initialAdministrators` are pinned.
- **Resources carry the authenticated identities:** `preparedBy`, `initiatedBy`, approval `decidedBy`, and every decision with its reason.
- **Restricted snapshots and their executions** are visible only to the preparer, approvers and administrators (404 otherwise). Only the preparer runs one or stores a new version of its name.
- **Secret bindings:** created only in Helm values (and pinned at admission, H4). Administrators can suspend or resume one through the API, never create or widen it.
- **Audit** (`audit.ts`): every sign-in, refusal, role change, binding change and execution step, with the acting identity, durable on the volume and on stdout.

**Approval:**
- **When:** executions that receive a Secret or run in egress mode (default `approval.requireFor`; `restricted` and `all` are available). They wait with no Job.
- **Decision:** an approver approves or rejects exactly the `requestDigest` they reviewed: sha256 over the execution's ID, snapshot digest, workflow, inputs, variables, network mode, Secret binding (name, Secret, keys) and initiator.
- **Re-checked:** the digest is recomputed at approval and at start. A different digest, a changed or suspended binding, or expiry invalidates it.
- **Separation of duties** (default): the approver may be neither the initiator nor the preparer.
- **After approval:** the Job starts at once, or later, by its initiator only, if a cluster check refuses at that moment.
- **Harmless executions** (isolated, no Secret) start at once.

**H3 key protection:**
- **No key exists outside the runner.** The runner generates an Ed25519 key pair at startup, in its protected (non-dumpable) memory. It writes the public key, naming its execution, as the log's first line, before any workflow process exists, and signs each event, chained.
- **Removed:** the Job's `GHA_EMERGENCY_EVENT_KEY`, and the executor's per-execution key files for new executions. The H4 policy no longer admits that variable.
- **Verification:** the executor verifies against the public key and requires it for every execution recorded since H2 (`eventAuth: ed25519`). A log that doesn't begin with that execution's key line is an error.
- **History:** executions recorded under H3 still verify with their kept key; older ones stay "not verifiable".
- **Evaluated:** delivering the key as a Kubernetes Secret volume. Rejected: workflow steps run as the runner's user and could read the mounted file, it can't be removed from a read-only volume, and the executor would need permission to create Secrets.

**Kubernetes boundaries** (checked on the test API server):
- **Executor RBAC unchanged:** Jobs create/get/delete, pods list, pods/log get, events list; no Secrets, pods/exec, Job updates, tokens or impersonation.
- **Runner:** no permissions.
- **No direct cluster access for users:** the API exposes no Kubernetes passthrough and builds every Job itself.
- **H4:** 66/66 on Kubernetes 1.35.0 with the H2 chart and images.

**Attack tests** (`tests/unit/emergency-executor.test.ts`, the "security review H2" blocks, through the real sign-in flow with the development provider in process; `tests/unit/emergency-auth.test.ts`):

| Attack | Result |
|---|---|
| Unauthenticated calls to all 24 sensitive routes | 401, each audited |
| The old shared operator token as a bearer token; a missing CSRF header | 401; 403 |
| ID tokens: foreign key, `none`, HS256, other audience, other issuer, expired, future `iat`, wrong nonce, no subject, other authorized party | sign-in refused, no session, reason audited |
| Callback without this browser's sign-in, with another sign-in's state, a replayed code, a provider error, an off-site return URL | refused (return URL ignored) |
| Forged role claims (`roles`, `groups`, custom) in the ID token | roles stay empty; 403 |
| Viewer uploading, executing, verifying, deleting, running checks | 403, no Job |
| Operator calling the administrator routes | 403, audited |
| Operator suspending a binding; anyone creating or deleting one through the API | 403; 405 |
| Another user's restricted snapshot by ID, list, verify, execute, delete, same content, name | 404 / not listed / 409 / refused |
| Another user's restricted execution by ID, list, stop | 404 / not listed |
| Claimed `preparedBy`, `initiatedBy`, `approval`, `state` in requests | ignored: the session's identity is recorded |
| Approval by an operator or viewer | 403 |
| Self-approval; approval of a run of a snapshot you prepared | 403 (separation of duties) |
| Approval replay with another request's digest | 409, audited |
| Binding changed or suspended after the request or the approval; expired request | invalidated, no Job |
| Rejected execution started or approved later | 409 |
| Starting an approved execution as someone other than its initiator | 403 |
| Granting yourself a role (operator, administrator); unknown role | 403; 422 |
| Expired (idle, absolute), signed-out, revoked, disabled-user sessions | 401; a disabled user can't sign in |
| Break-glass without a reason, with a wrong credential, after five failures, past an hour; as administrator | 422 / 401 / locked out / 401; refused by the configuration |
| Reading the event key: Job spec, executor files, API responses, audit | none exists (H3 tests) |

**Legitimate flows:**
- **Executor API:** an operator prepares, requests and follows; an approver approves and the Job starts; two break-glass accounts complete the same flow; administrators manage roles.
- **Browser:** the mocked-executor browser test signs in, prepares, requests, signs in as an approver, approves and follows the run.

**Regression:**
- **Unit tests:** 641 passed, 1 skipped (52 files), 40 more than before H2; every earlier executor test now runs through the real sign-in.
- **Runner check:** 6/6 (C1, H1).
- **H3 attack check:** 30/30 on the H2 runner image, including the new private-key probes and key-line tampering. **s16** succeeds through the real entrypoint (exit 0, authenticated stream).
- **H4 admission check:** 66/66.
- **Images:** executor modules load in the image; it refuses invalid sign-in configuration at startup.
- **Static checks:** tsc and eslint clean.
- **Full browser regression** (2026-11-02, all 36 spec files, run in four batches of nine because a single run was stopped for low memory): **184 passed, 4 skipped, 0 failed**. The skipped tests are opt-in: the two showcase captures and the two live-executor phases, which need a real cluster.

**What remains:**
- **An external identity provider is required.** It must not depend on GitHub, and must be registered with the executor's exact redirect URI. Roles are per user, with no directory-group mapping.
- **Root of trust:** Kubernetes cluster administrators, who install the chart, read break-glass credentials and Secrets, and can change the configuration. The API can't constrain them.
- **One executor replica:** pending sign-ins are kept in memory (a restart loses sign-ins in progress). Sessions and users are files on its volume.
- **No rate limiting** of OIDC sign-in attempts (break-glass has a lockout).
- **The browser session** is as strong as the device. Sessions end on sign-out, idle or revocation, not on changes at the identity provider (no back-channel logout).
- **Not tested with a real OpenID Connect provider** (Entra ID, Okta, Keycloak…), and not deployed. Discovery, JWKS and the code exchange are tested only against the development provider, in process. Before production: sign in through the organization's provider, including key rotation and a confidential client.
- **The ID-token verification is custom code** (`deploy/emergency/executor/auth/jwt.ts`, on Node's crypto, to avoid a dependency). It is unit-tested against forged, mis-signed and mis-claimed tokens, but needs a focused security review (or replacement by a maintained library such as `jose`) before production.
