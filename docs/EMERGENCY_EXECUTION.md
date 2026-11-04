# Emergency execution (MVP)

**Status:** MVP implemented 2026-10-30; committed with the security remediations through H2 on 2026-11-02, for review. **Not deployed.**
- **Directed by the project owner** on 2026-10-30. This is a deliberate change from the earlier position that the app stays read-only and that recovery execution should not live in this repository (`docs/KUBERNETES_ACCESS.md` §4–§8, Q-R1).
- The change applies **only** to this separate, optional component.
- **The read-only investigation app is unchanged:** same token, same permissions, GET-only GitHub client, same CSP.
- Earlier proposals (K-1…K-11, Q-R1, Q-R2) are not retroactively approved by this note.

**What it does:**
1. **Prepare.** While GitHub is available, a user prepares an immutable snapshot of selected workflows at an exact commit, with everything needed to run them.
2. **Run.** When GitHub Actions is unavailable, the snapshot runs as a Kubernetes Job that has no access to GitHub.
3. **Review.** The user inspects the results.
4. **Reconcile.** After GitHub recovers, the user reconciles by hand. Nothing is reported back to GitHub.

Only a **documented subset** of GitHub Actions is reproduced (§6). Validation refuses everything else before an emergency, and nothing is skipped silently.

**Security review:** `docs/EMERGENCY_EXECUTION_SECURITY_REVIEW.md`.
- **C1, C2, H1, H2, H3 and H4 are remediated** (committed through H2 on 2026-11-02). Sections 4, 5, 7 and 10 describe the remediated behaviour.
- **The medium (M1–M7) and low findings are open**, H2 has not been tried with a real identity provider, and its ID-token verification awaits a focused review, so this is **not ready for production**.

## 1. Architecture

```
 Browser (existing app, #/emergency, lazy-loaded chunk)
   │  prepare: GET-only GitHub client, existing token (Actions/Contents/Metadata: Read)
   │  ── api.github.com  (only while GitHub is available)
   │
   │  upload / list / run / follow: same-origin api/emergency/, signed-in session (HttpOnly cookie)
   ▼
 Executor pod (charts/gha-emergency, image target "executor")
   │  serves the UI build + API; verifies and stores snapshots write-once on its volume
   │  Kubernetes API only (Role: Jobs create/get/delete, pods list, pods/log get, events list; no Secrets)
   ▼
 Runner Job pod (image target "runner"), one per execution
      snapshot mounted read-only (subPath of the executor's volume), Secret mounted as files,
      no service-account token, no DNS (isolated mode), GitHub hosts → 127.0.0.1, restricted pod security
```

| Part | Code |
|---|---|
| Shared, pure (browser, executor and runner) | `src/emergency/`: `expressions.ts` (expression subset), `model.ts` (workflow and action parsing), `prepare.ts` (dependency resolution and packaging), `snapshot.ts` (format, digest, verification), `events.ts` (runner event protocol) |
| Browser | `src/emergency/github-reader.ts`, `executor-client.ts`; `src/ui/emergency/*` |
| Executor | `deploy/emergency/executor/`: `server.ts`, `api.ts`, `store.ts`, `job-spec.ts`, `kube.ts` |
| Runner | `deploy/emergency/runner/`: `engine.ts`, `main.ts` |
| Images and chart | `deploy/emergency/Dockerfile` (targets `executor`, `runner`), `charts/gha-emergency/` |
| Demo pipeline | `examples/emergency-demo`, `examples/emergency-demo-shared-actions`; served in fixture mode by `tools/fixture-server/emergency-demo.ts` |

**How the parts run:**
- The executor and runner run the TypeScript sources directly on Node 22's type stripping. There is no separate build output to review.
- No new backend service talks to GitHub.
- The only server added is the executor, and it is optional. The `gha-ui` chart and its image are untouched.

## 2. Snapshot preparation

Preparation runs in the browser, in `#/emergency/prepare`.

1. **Pin the commit.** The ref is resolved once to a commit SHA (`GET …/commits/{ref}`). The commit's full file list comes from `GET …/git/trees/{sha}?recursive=1`, and a truncated listing is refused. Files are read by blob SHA (`GET …/git/blobs/{sha}`). Every byte therefore comes from the pinned commit. These three GET methods are new in `src/github/client.ts`, and need no new permission.
2. **Resolve dependencies.** Starting from each selected workflow, preparation resolves:
   - jobs, `needs`, `if`, `env`, `outputs` and `defaults`;
   - reusable workflows (`uses: ./.github/workflows/x.yml` or `owner/repo/.github/workflows/x.yml@ref`), recursively up to depth 10, with cycle detection. It checks inputs, required inputs, declared and passed secrets, `secrets: inherit` and `workflow_call` outputs;
   - steps' `uses:`, which can be:
     - local actions (`./path`);
     - external actions (`owner/repo[/path]@ref`), whose ref is resolved to a SHA and whose repository is packaged at that commit;
     - nested composite actions;
     - `actions/checkout` of the snapshot's own repository, which is replaced by the packaged workspace and shown as a substitution;
   - JavaScript actions: `runs.using` and `main`/`post` existence. Bare `require`/`import` specifiers in the entry files are checked against Node built-ins and packaged `node_modules`. An unbundled dependency is an error.
   - scripts referenced from `run:`, which must be packaged;
   - every `${{ }}` expression: contexts, functions, secret names, variable names, and GitHub-only values.
3. **Package.** The workspace is packaged whole, or limited to the chosen path prefixes, always keeping `.github/`. Excluding a script that a step uses is an error. Each file is pinned by sha256, and its executable bit is kept.
4. **Write the manifest.** It holds:
   - source repository, ref and SHA;
   - roots (the workspace and each external repository at its SHA);
   - the execution graph;
   - resolved actions;
   - requirements: secret **names**, variable names, inputs per entry workflow, runtimes, and external services detected in scripts;
   - diagnostics (error, warning, info);
   - files and totals.
5. **Upload.** The browser sends `{ manifest, contents }`. **Secret values are never part of a snapshot**, and the GitHub token is never sent to the executor.

**Immutability and lifecycle:**
- **Identity.** A snapshot's ID is the sha256 of its canonical manifest. The manifest pins every file by sha256, so identical content always has the same ID.
- **Verification.** The executor verifies the upload (structure, safe paths, sizes, hashes, totals, expiry), writes it to a temporary directory, makes it read-only and renames it into `snapshots/<digest>/`.
- **No overwrites.** An existing digest is never overwritten.
- **Versions.** Re-preparing creates a new version under the same name. The manifest records its creation time, so re-preparing the same commit creates a new version too.
- **Expiry.** Snapshots expire after 1–90 days (chosen at preparation). The executor removes expired snapshots on start and on every listing. Executions refuse expired snapshots.
- **Repeated checks.** Stored snapshots are re-verified before every execution and on demand ("Verify stored files"). The runner verifies again inside the Job, including that the digest is the one requested.
- **Limits:** 3,000 files, 40 MB in total, 10 MB per file, 2,000 files per external repository.

## 3. Storage choice

| Option | For | Against | Decision |
|---|---|---|---|
| **PersistentVolume on the executor (chosen)** | Simplest with the existing chart; no registry or image build at preparation time; content-addressed, write-once directories; the runner mounts one snapshot read-only via `subPath` | ReadWriteOnce: runner pods are pinned to the executor's node (pod affinity); losing the volume loses snapshots; a backup is the operator's job | MVP |
| Container image per snapshot | Immutable by digest; distributable; runs on any node | Needs a registry reachable during the outage (not `ghcr.io`) and an image build at preparation time, which can't happen in the browser | Later option for multi-node clusters |
| Object storage (S3-compatible) | Durable; any node | Another dependency and its credentials; the runner would need network egress to fetch | Not chosen |
| ConfigMap or Secret | No storage needed | 1 MiB limit | Too small |

## 4. Kubernetes execution

**The Job** (`job-spec.ts`):
- `backoffLimit: 0`, `activeDeadlineSeconds = maxMinutes·60 + 120`, `ttlSecondsAfterFinished` (default 1 day).
- Its own service account with **no role bindings**, and `automountServiceAccountToken: false`.
- `enableServiceLinks: false`.
- Pod and container security:
  - `runAsNonRoot`, uid and gid 1000, `RuntimeDefault` seccomp;
  - `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, all capabilities dropped;
  - CPU, memory and ephemeral-storage limits;
  - `emptyDir` working space with a size limit.

  This was admitted in a namespace enforcing Pod Security **restricted**.
- **Network (security review C2).** The boundary is **NetworkPolicy**, which works only where the cluster's network plugin enforces it (for example Calico or Cilium; not kindnet).
  - **Baseline policy:** every runner pod has no ingress and no egress.
  - **Canary:** before isolated executions run, the executor proves enforcement. A probe pod with exactly an execution's labels and network settings must fail to reach:
    - an external IP address;
    - the Kubernetes API;
    - the cloud metadata address;
    - an internal service (the executor's own).

    A control pod outside the policy must reach that internal service.
  - **Verdict:** isolated executions are refused unless the canary's verdict is "enforced". A passing verdict is reused for up to 15 minutes; any other verdict only for 30 seconds. The first check runs 20 seconds after startup, because the control pod connects to the executor's own Service, which has no ready endpoint before then (seen live).
  - **Defense in depth only:** `hostAliases` (11 GitHub hostnames pinned to 127.0.0.1) and, in isolated mode, `dnsPolicy: None` remain.
  - **"github-blocked" was removed:** it blocked only names.
  - **Egress mode** replaces it. It is opt-in (`network.allowEgressMode`) and **not isolated**: public addresses are reachable, including GitHub's. Private, link-local and metadata ranges are excluded, and egress runs need a passing egress canary too.

**The runner** (`engine.ts`):
1. Reads the mounted Secret's files, and masks their values from that point on.
2. Verifies the snapshot (all hashes, the requested digest, no validation errors, required secrets present).
3. Probes `github.com`, `api.github.com` and `codeload.github.com` and reports reachability as evidence.
4. Runs the entry workflow:
   - jobs one at a time in `needs` order (file order among ready jobs), each with a **fresh copy** of the packaged workspace;
   - reusable workflows inline, as `caller/inner` jobs;
   - job `if` with needed-job status, so dependents of failed or skipped jobs are skipped;
   - step `if`, `continue-on-error`, `timeout-minutes` (capped) and `working-directory` (confined to the workspace).
5. Supports `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE` and `GITHUB_STEP_SUMMARY`, and the workflow commands `::set-output::`, `::add-mask::`, `::error::`, `::warning::`, `::notice::` and `::save-state::`.
6. Gives each process a minimal environment. The runner's own environment (for example Kubernetes service addresses) isn't passed on.
7. Emits one JSON event per line. The executor reads them from the pod log, archives the log when the Job finishes, and returns:
   - status;
   - jobs and steps, with exit codes and durations;
   - outputs, logs and annotations;
   - integrity and network evidence;
   - why a pod couldn't start (from its warning events, for example a missing Secret).

**The UI** shows the snapshot, source commit, status, job and step progress, logs, exit codes and the final result. It polls every 2 s while the execution runs. It never receives Kubernetes credentials. The browser can only call the executor's fixed API, which accepts nothing but a snapshot ID, an entry workflow, declared inputs, required variable names, a Secret **name** and a network mode.

## 5. Secrets and security

**Secrets:**
- **Values** are supplied as a Kubernetes Secret, created beforehand by someone with namespace access (`kubectl create secret generic … --from-literal=NAME=…`).
- **Bindings (security review C1).** An execution receives a Secret only through a binding in the chart's `secretBindings` values, set by a cluster administrator, not chosen in the request.
  - **Scope.** A binding names one Secret, the keys it may provide, and the exact snapshot **digests** it serves. Names and claimed repositories can be forged (review H1), so they authorize nothing.
  - **Mounting.** Only the keys the snapshot requires are mounted (volume `items`).
  - **Refused** (by the chart, the executor and the bindings loader): the operator-token Secret, invalid bindings (which void every binding), and ambiguous bindings.
  - **Runner check.** The runner refuses to start if any key it doesn't require is mounted.
  - **At install and upgrade,** the chart requires:
    - a namespace labelled dedicated and enforcing Pod Security "restricted";
    - no Secrets other than the break-glass credentials, the identity provider's client secret, Helm's records and bound Secrets;
    - every bound Secret to exist, be Opaque and hold its keys.
- **Mounting:** only the runner pod mounts it, read-only, as files (mode 0440).
- **What can read them:** the executor has **no** permission to read Secrets (verified with `kubectl auth can-i`). Values never appear in Job specs, API responses, the browser, snapshots or audit logs.
- **Masking:** the runner masks values (and `::add-mask::` values) in every log line, output and reason.
- **Tested:** the live end-to-end test asserts that the demo secret's value is absent from the page.

**Tokens:**
- The **GitHub token** stays in the browser and is used only for GET requests during preparation. It is never sent to the executor or a Job. Steps that need `GITHUB_TOKEN` or `github.token` are refused at validation.
- The **shared operator token is gone** (security review H2): a bearer token is refused on every API call. Its Secret now holds break-glass credentials (below).

**Identity, roles and approval (security review H2):**
- **Sign-in.** Users sign in with the organization's OpenID Connect provider (`auth.oidc`). The executor runs the authorization code flow with PKCE, state and nonce itself, verifies the ID token (signature from the issuer's JWKS, an allow list of asymmetric algorithms, issuer, audience, authorized party, expiry, issued-at, nonce) and keeps nothing from it but the identity (issuer and subject) and a display name.
- **Sessions** are server-side: a random token in a `__Host-` cookie that is HttpOnly, Secure and SameSite=Strict, stored only as its hash. Defaults: 8 hours absolute, 1 hour idle. Signing out, an administrator's "End sessions" or disabling the user ends them at once. Every API call must also carry `X-GHA-Emergency: 1`, which other origins can't send.
- **Roles** (`deploy/emergency/executor/auth/roles.ts`) come only from the executor's own records, never from token claims:
  - viewer: shared snapshots, executions, logs, cluster checks;
  - operator: also prepares snapshots, starts executions, stops and deletes its own;
  - approver: also approves or rejects executions that need it;
  - administrator: also manages other users' roles and sessions, suspends Secret bindings, reads the audit log, and stops or deletes anything.
  - Nobody changes their own roles. `auth.initialAdministrators` are pinned administrators, the way a new installation gets its first ones.
- **Ownership.** Snapshots record who stored them, executions who prepared, started and approved them, from the session, never from the request. A snapshot can be `restricted`: only its preparer, approvers and administrators see it (others get 404, as for an unknown ID), and only its preparer runs it or stores a new version of its name.
- **Approval.** By default an execution that receives a Secret, or runs in egress mode, waits for an approver (`approval.requireFor`; `all` and `restricted` are also available). No Job exists until approval.
  - The approval is bound to a digest of exactly what will run: snapshot, workflow, inputs, variables, network mode, Secret binding and initiator.
  - A different digest, a changed or suspended binding, or expiry (60 minutes) invalidates it.
  - Under separation of duties (default), the approver may be neither the initiator nor the preparer.
  - Harmless executions (isolated, no Secret) start at once.
- **Secret bindings** stay cluster configuration (Helm values, pinned again by the H4 admission policy). Administrators can only suspend and resume one through the API.
- **Break-glass** (`auth.breakGlass.accounts`, off by default), for an identity-provider outage:
  - named accounts, each with its own generated credential (a key of the break-glass Secret, read by cluster administrators) and pinned roles, never administrator;
  - every sign-in needs a reason, is audited, and lasts at most an hour; repeated failures lock the account out.
  - Give an operator account and an approver account to different people.
- **Audit.** Every sign-in, refusal, change and execution step is a JSON line with the acting identity, on the executor's volume (`<data>/audit/`) and stdout, readable by administrators. It never holds secret values, session tokens or keys.

**Least privilege:** the executor's Role is limited to its namespace: Jobs `create/get/delete`, pods `list`, `pods/log get`, events `list`. The runner has no Kubernetes permissions.

**Admission (security review H4):** RBAC can't constrain what a Job runs, so the API server does.
- **The policy.** The chart installs a ValidatingAdmissionPolicy and its binding (`templates/admission-policy.yaml`) for the release namespace. Every Job created there, by anyone, and every pod a Job creates (checked again after mutating admission, so injected sidecars are refused too) must be one of the shapes `job-spec.ts` builds:
  - **What runs:** the runner image **by digest** (`runner.image.digest`), `IfNotPresent`, one container named `runner`, no init or ephemeral containers. Only the runner's or the canary's exact command, with no arguments, hooks, probes or ports.
  - **Security context:** the runner service account with no token, no host network, PID or IPC namespace. Non-root, RuntimeDefault seccomp, no privilege escalation, read-only root filesystem, all capabilities dropped.
  - **Resources:** cpu, memory and ephemeral-storage limits within the chart's runner values; one pod, no retries, a deadline.
  - **Volumes:** size-limited emptyDirs, the snapshot volume read-only at one snapshot's directory, and Secret keys that `secretBindings` give **that** snapshot's digest. Nothing else: no hostPath, other Secrets, ConfigMaps or projected tokens.
  - **Environment:** the runner's own variables, with literal values only. No Secret references and no `envFrom`.
  - **Network:** the labels the runner NetworkPolicies select, in an enabled network mode.
  - **Namespace:** Jobs are refused unless the namespace is labelled dedicated and Pod Security "restricted".
- **Proven, not assumed.** Before every execution (cached 15 minutes), the executor sends two server-side dry runs (`admission-check.ts`): a canary Job with a hostPath volume must be denied by the policy, and the same Job without it must be accepted. Otherwise it refuses with "the cluster does not enforce the runner admission policy". The state is at `GET api/emergency/admission-check`. The dry runs use the existing `create jobs` permission.
- **Requirements:** Kubernetes 1.30 or later (ValidatingAdmissionPolicy v1), which the chart's `kubeVersion` and install checks enforce. The installing user needs permission to create the cluster-scoped policy and binding.

**Execution evidence (security review H3):**
- **The runner is out of the workflow's reach.** Steps run as the runner's own user (uid 1000). The runner, PID 1, is started from an execute-only copy of node, so the kernel marks it non-dumpable. Its `/proc` entries then belong to root, so steps can't write to its stdout, read its memory or environment, or ptrace it. As PID 1 it ignores signals it has no handler for, and `--disable-sigusr1` keeps a signal from starting the inspector. The runner checks this at startup and refuses to run without it. This depends on the node's `fs.suid_dumpable` being 0 or 2, which is the default.
- **Events are authenticated.** The executor generates a key per execution, passes it only to the runner's Job and keeps it apart from the execution's metadata. The runner removes it from its environment, and steps never receive it. Each event line carries an HMAC-SHA256 chained to the previous one (`src/emergency/event-stream.ts`).
- **What the executor believes:** only authentic events, up to the first line that isn't one. A finished run needs the runner's authentic final event, and that result must agree with the runner container's exit code from Kubernetes, which is archived with the log. Anything else is reported as an **error**, never as the result the log claims. Executions from before H3 have no key and are shown as "not verifiable".
- **Workflow text is data.** Step output, names, outputs, reasons and annotations are masked, then sanitized: control characters, ANSI escapes and bidirectional or invisible characters are shown escaped. The UI labels every log line with its source (`runner`, `out` or `err`), and `::error::`-style annotations as "reported by the workflow".

**Audit:** the executor logs JSON lines for snapshot stored, snapshot deleted, execution started (input names only) and execution stopped.

**Validation:**
- Uploads are re-verified server-side.
- Paths are normalized and can't escape their root.
- Request bodies are size-limited.
- Inputs must be declared, are strings, and are at most 4 KB.
- Secret names must be Kubernetes names.
- Concurrency is limited (default 2).

## 6. GitHub Actions compatibility

**Never claimed: complete compatibility.** "Refused" means snapshot validation reports an error, and the snapshot can't run.

| Feature | Emergency behaviour |
|---|---|
| Triggers (`push`, `pull_request`, `schedule`, …) | **Not reproduced.** Runs start manually, like `workflow_dispatch` with inputs; shown as a note |
| `workflow_dispatch` / `workflow_call` inputs | Supported (types string, boolean, number; defaults; required) |
| Reusable workflows, nested | Supported (local and external at a pinned SHA); inputs, outputs, explicit secrets, `secrets: inherit` |
| `needs` | Supported; jobs run **sequentially**, not in parallel |
| `if:` (jobs, steps), status functions | Supported (`success()`, `failure()`, `always()`, `cancelled()`) |
| Expressions | Subset: literals, property and index access, `! == != < <= > >= && ||`, `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`. **Refused:** `hashFiles`, object filters `.*`, dynamic `secrets[…]` |
| Matrix strategies | **Refused** |
| Job and step outputs | Supported |
| `env` (workflow, job, step), `GITHUB_ENV`, `GITHUB_PATH` | Supported |
| Secrets | Supported, from a Kubernetes Secret. **`GITHUB_TOKEN` and `github.token` refused** |
| `vars.*` | Supported as execution-time variables (not secret) |
| `run:` shells | bash (default), sh, python. **Refused:** pwsh, cmd, powershell |
| Composite actions | Supported, nested; inputs and outputs; `secrets` in a composite refused (as on GitHub) |
| JavaScript actions | Supported: `main`, and `post` at job end with `post-if`. Runs on **Node 22** whatever `node20`/`node24` says (warning). **Refused:** `node12`/`node16`, `pre:`, unbundled dependencies |
| Docker actions, `docker://` | **Refused** |
| `actions/checkout` | Of the snapshot's own repository: replaced by the packaged workspace. **Refused:** another repository, `path:`, submodules, LFS |
| Artifacts (`upload-` / `download-artifact`) | **Refused** (GitHub service). Jobs don't share files: each gets a fresh workspace |
| Caches (`actions/cache`) | **Refused** (GitHub service) |
| `setup-node`, `setup-python`, `setup-go`, `setup-java` | **Refused**: they download toolchains. Use the image's Node 22 and Python 3 |
| `github-script`, Pages and release actions | **Refused** (GitHub API or services) |
| Service containers, job `container:` | **Refused** |
| `runs-on`, GitHub-hosted runner software | Ignored (warning): everything runs in the runner image (Node 22, bash, sh, Python 3 standard library). No preinstalled tools beyond that |
| Self-hosted runner labels and behaviour | Ignored; no runner registration |
| `environment:`, protection rules, environment secrets | Not enforced (warning) |
| `permissions:`, `concurrency:` | Ignored (warning) |
| `github` context | Substitute values: repository, sha, ref, `event_name: workflow_dispatch`, `event.inputs`, `run_id` = execution ID. `github.event.*` payload refused; other keys empty (warning) |
| Actions or scripts calling GitHub APIs, `gh`, `git clone/fetch/push` | Can't work: GitHub is blocked. Scripts are scanned and listed under external services; JavaScript action code is not analysed for API calls |
| OIDC (`id-token: write`) | **Not available** (GitHub's issuer). Steps fail |
| Job and step timeouts | Supported, capped by `maxMinutes` |

**Needs GitHub, so can't be reproduced during an outage:** triggers and event payloads, `GITHUB_TOKEN`, OIDC tokens, artifacts, caches, checks/statuses/deployments, environments and their secrets, `ghcr.io` images, downloads from GitHub releases (setup actions), GitHub-hosted runner images.

## 7. Independence from GitHub

**Preparation is the only part that contacts GitHub.** During an emergency:
- the snapshot is read from the executor's volume;
- the runner image already contains Node 22, bash and Python 3;
- external actions were packaged at their SHAs;
- nothing is cloned or downloaded;
- no GitHub runner or API is used.

**Verified on the live run:** `github.com`, `api.github.com` and `codeload.github.com` were unreachable from the Job ("TCP connection to 127.0.0.1:443 failed (ECONNREFUSED)"), and the demo still succeeded.

**Other services:**
- **Package registries** (npm, PyPI, OS packages, container registries) and other hosts are **unreachable in isolated mode**, because there is no DNS. Steps that install packages fail, and preparation lists them under "External services".
- **Third-party Python packages** must be vendored in the repository; the image has only the standard library.
- **JavaScript actions** must ship their dependencies (bundled `dist/`, or committed `node_modules`).
- **The images** must already be on the cluster's nodes, or in a registry reachable during the outage. Images that exist only in `ghcr.io` will not pull.

**Isolation now depends on enforced NetworkPolicy (security review C2):**
- **minikube with kindnet:** NetworkPolicy is **not enforced**. A pod with the runner labels connected to a raw IP address (1.1.1.1:443) during the review. On such a cluster the canary reports "not-enforced", and the executor refuses isolated executions instead of running them with name-based blocking only.
- **The live minikube run in §8 predates this change.** Its "GitHub unreachable" result came from name-based blocking alone.
- **Clusters that enforce NetworkPolicy: validated live on 2026-10-30** on a separate minikube profile, `gha-sec`, running Calico.
  - **From inside a real execution:** every direct-IP connection was blocked (external IPs, API server ClusterIP and node port, kubelet, executor, cluster DNS).
  - **Comparison:** an otherwise identical pod without the runner labels reached them all.
  - **Removing the policy:** the canary flipped to "not-enforced", and executions were refused.
  - Details are in the security review's remediation log.
  - **Not provable there:** blocking of the metadata address, because minikube has no metadata service.

## 8. Tests and evidence (2026-10-30)

- **Security review C1/C2 regression tests** are in `docs/EMERGENCY_EXECUTION_SECURITY_REVIEW.md` ("Remediation log"). After that work: 552 passed, 1 skipped.
- **Unit tests before C1/C2** (`npx vitest run`): 531 passed, 1 skipped. The skipped one is the runner end-to-end test, Linux-only, which passed in containers (below). New suites:
  - `src/emergency/expressions.test.ts`;
  - `src/emergency/prepare.test.ts`: demo resolution, required secrets and inputs, integrity and tampering, determinism, supporting-file selection, and refusal rules;
  - `tests/unit/emergency-executor.test.ts`: authentication, write-once storage and versions, tampered uploads, on-volume changes, request validation, Job security properties, progress and archiving, concurrency, expiry, unreadable logs, pods that can't start;
  - `tests/unit/emergency-runner.test.ts`.
- **Runner end-to-end** (`node tools/emergency/runner-check.ts`): 4 of 4 scenarios passed.
  - The demo pipeline, in dependency order, with outputs flowing across jobs and the reusable workflow, and the secret never emitted.
  - A missing secret stops the run.
  - A tampered snapshot is refused.
  - A failing step fails its job and skips its dependents, with exit code 3 recorded.

  It ran in `node:22.23.4-bookworm` with `--network none`, and in the runner image as uid 1000 with a read-only root filesystem, no capabilities and no network.
- **Browser** (`npx playwright test tests/e2e/emergency.spec.ts`): the mocked-executor flow and the no-executor state pass. The **live** flow passed against minikube with `GHA_EMERGENCY_LIVE=1`:
  - prepare in the UI;
  - upload;
  - verify stored files;
  - run as a Kubernetes Job with isolated networking;
  - 5 jobs and 15 steps succeeded in order;
  - GitHub unreachable;
  - the secret value absent from the page.
- **Cluster checks:**
  - RBAC by `kubectl auth can-i` (the executor can't read Secrets; the runner can do nothing);
  - the admitted Job spec;
  - a missing Secret reported as "Pod not started: FailedMount … not found";
  - Stop deletes the Job.

**Not tested:**
- multi-node clusters;
- NetworkPolicy enforcement;
- `post:` scripts, `GITHUB_PATH`, boolean and number inputs, `continue-on-error`, `secrets: inherit` and external reusable workflows on a live cluster (only some have unit-level coverage);
- real-world third-party actions;
- large repositories near the limits;
- long-running steps and the timeout kill path;
- snapshot backup and restore.

## 9. Known gaps

1. **Identity depends on an external OpenID Connect provider** (security review H2). It must work during a GitHub outage, so it can't be GitHub. Break-glass accounts cover its own outages. Roles are per user, not per group: no directory group mapping.
2. **Secrets are created out of band** with `kubectl`. Anyone who can create Secrets or Jobs in the namespace has more power than the UI grants.
3. **The demo runs in fixture mode** (a simulated GitHub serving `examples/`).
   - **Verified:** on 2026-10-30, three unauthenticated GETs to `octocat/Hello-World` confirmed that GitHub's commit, tree and blob responses have the fields the reader uses (`sha`; `truncated`, `mode`, `type`, `size`, `sha`; `encoding: base64`, `content`).
   - **Not verified:** a full preparation of a real repository with a token.
   - **Request cost:** preparation makes one request per packaged file, so large repositories should be limited to supporting-file prefixes.
4. **The runner image is a single, generic environment.** Workflows that need other tools must vendor them, or a custom runner image is needed (not yet configurable per snapshot).
5. **Jobs run sequentially in one pod.** There is no per-job isolation beyond fresh workspace directories, and no parallelism.
6. **Script scanning is heuristic.** Missing scripts and network use inside JavaScript actions or indirect script calls may go undetected until run time.
7. **Snapshot identity includes the creation time**, so re-preparing identical content creates a new version rather than reusing one.
8. **There's no reconciliation support** beyond the UI's reminder. No record of the emergency run is written anywhere outside the executor.
9. **Base images are pinned by tag**, not digest, as for the UI image. The runner image itself is pinned by digest and enforced at admission (H4); the executor image is still referenced by tag.
10. **Isolated executions need an enforcing network plugin.** Validated on `gha-sec` (Calico). The original `minikube` profile (kindnet) doesn't enforce NetworkPolicy, so the MVP deployed there would refuse isolated executions once upgraded; it was left unchanged.

## 10. Run the MVP locally (Windows with Podman and minikube, as tested)

```powershell
# Isolated executions need a network plugin that enforces NetworkPolicy. As validated on 2026-10-30, a separate
# Calico profile next to the existing one (always name the profile; --keep-context leaves kubectl's context alone):
minikube start -p gha-sec --driver=podman --container-runtime=cri-o --kubernetes-version=v1.35.0 --cni=calico --cpus=2 --memory=2560 --keep-context
kubectl --context gha-sec -n kube-system rollout status ds/calico-node --timeout=300s

# 1. Build the images and load them into that profile only
podman build --ignorefile deploy/emergency/build.dockerignore -f deploy/emergency/Dockerfile --target executor -t gha-emergency-executor:c1c2 .
podman build --ignorefile deploy/emergency/build.dockerignore -f deploy/emergency/Dockerfile --target runner   -t gha-emergency-runner:c1c2 .
podman save --format oci-archive -o executor.tar localhost/gha-emergency-executor:c1c2; minikube -p gha-sec image load executor.tar
podman save --format oci-archive -o runner.tar   localhost/gha-emergency-runner:c1c2;   minikube -p gha-sec image load runner.tar
# Security review H4/M7: both images are pinned to their digest as the node's runtime knows it (not from podman: a
# loaded archive can get a different digest). Runner Jobs use runner.image.digest; the executor runs by
# executor.image.digest so a mutable tag can't change what the privileged component runs. Read both on the node:
minikube -p gha-sec ssh -- sudo crictl inspecti -o go-template --template "{{range .status.repoDigests}}{{.}} {{end}}" localhost/gha-emergency-runner:c1c2
minikube -p gha-sec ssh -- sudo crictl inspecti -o go-template --template "{{range .status.repoDigests}}{{.}} {{end}}" localhost/gha-emergency-executor:c1c2

# 2. A dedicated, restricted namespace, then install. No Secrets yet: the chart refuses any Secret that isn't bound,
#    and a binding needs the digest of a snapshot that is prepared after installation.
#    Sign-in (security review H2): this local profile has no identity provider, so two break-glass accounts, held by
#    different people, stand in for one (a real installation sets auth.oidc and auth.initialAdministrators).
kubectl --context gha-sec create namespace gha-emergency
kubectl --context gha-sec label namespace gha-emergency pod-security.kubernetes.io/enforce=restricted gha-emergency.github-actions-ui/dedicated=true
# UI origin (security review M5): the executor must not serve the GitHub-token UI. Point it at the separate trusted
# origin (the gha-ui chart), where the token is entered and snapshots are prepared; the executor serves only the
# execution console. For a quick single-origin local demo use `--set ui.mode=bundled` instead (explicitly insecure).
helm --kube-context gha-sec install gha-emergency charts/gha-emergency -n gha-emergency --set executor.image.digest=sha256:<executor-digest> --set runner.image.digest=sha256:<runner-digest> `
  --set "auth.breakGlass.accounts[0].name=local-operator" --set "auth.breakGlass.accounts[0].roles[0]=operator" `
  --set "auth.breakGlass.accounts[1].name=local-approver" --set "auth.breakGlass.accounts[1].roles[0]=approver" `
  --set ui.trustedUiUrl=https://gha-ui.example   # or: --set ui.mode=bundled  (single-origin local demo)

# 3. Reach the executor, and read the break-glass credentials (see the chart's NOTES)
kubectl --context gha-sec -n gha-emergency port-forward svc/gha-emergency 18094:8080

# 4. After preparing the demo snapshot (below): create the Secret, then bind it to the snapshot's digest in the same
#    sitting (an unbound Secret makes later upgrades fail the dedicated-namespace check).
kubectl --context gha-sec -n gha-emergency create secret generic demo-secrets --from-literal=DEMO_SIGNING_KEY=<value>
helm --kube-context gha-sec upgrade gha-emergency charts/gha-emergency -n gha-emergency --reuse-values `
  --set "secretBindings[0].name=release-demo" --set "secretBindings[0].secret=demo-secrets" `
  --set "secretBindings[0].keys[0]=DEMO_SIGNING_KEY" --set "secretBindings[0].snapshots[0]=<digest>"
```

**Use the demo pipeline** (fixture mode, so no GitHub access is needed):
1. Start the dev server with `GHA_EMERGENCY_API_PROXY=http://127.0.0.1:18094 npm run dev`.
2. Open `http://localhost:5173/?mode=fixtures#/emergency` and sign in with the `local-operator` break-glass account (or the identity provider, where configured).
3. Choose **Prepare a snapshot**: repository `emergency-demo/release-pipeline`, ref `main`, then `release.yml`.
4. **Resolve**, then **Create**, then **Open the snapshot**. It shows "Not authorized" and the digest to bind.
5. Create and bind the Secret (step 4 above). The executor picks the binding up within about a minute.
6. Enter version `2.0.1`, check that the network verdict reads "Isolation verified", then **Request emergency execution**: it receives a Secret, so it waits for approval.
7. In another browser profile, sign in as `local-approver`, open the execution and **Approve and start**.

**With a real repository:**
- Open `http://127.0.0.1:18094/#/emergency` (the executor serves the production UI).
- Connect to GitHub for preparation.
- Then the same steps.

**Automated** (live, in two phases; see `tests/e2e/emergency.spec.ts`):
- Phase 1: `GHA_EMERGENCY_LIVE=1 GHA_EMERGENCY_API_PROXY=http://127.0.0.1:18094 GHA_EMERGENCY_LIVE_OPERATOR=local-operator:… GHA_EMERGENCY_LIVE_APPROVER=local-approver:… npx playwright test tests/e2e/emergency.spec.ts -g "phase 1"` prepares the snapshot and writes its digest to `test-results/emergency-live-digest.txt`. Copy the digest elsewhere: Playwright clears `test-results/` on the next run.
- Bind it (step 4).
- Phase 2: the same command with `GHA_EMERGENCY_LIVE_SNAPSHOT=<digest>` and `-g "phase 2"`.
- The runner alone, without Kubernetes: `podman run --rm --network none -v ${PWD}:/repo:ro -w /repo --entrypoint node localhost/gha-emergency-runner:c1c2 tools/emergency/runner-check.ts`
- The H3 attack check, through the runner's real entrypoint (`<out>` is an empty directory). To include s16, first copy its snapshot directory to `<out>/s16-snapshot` and its digest to `<out>/s16.digest`.
  1. `podman run --rm --network none -v ${PWD}:/repo:ro -v <out>:/out --entrypoint node <runner image> /repo/tools/emergency/runner-attack-check.ts prepare /out`
  2. Run each snapshot as a pod would, capturing stdout and stderr together, with the snapshot directory named in `<out>/attack.snapshot`:
     `podman run --rm --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000 --tmpfs /work:rw,exec,mode=1777 --tmpfs /tmp:rw,exec,mode=1777 -v <snapshot dir>:/snapshot:ro --env-file <out>/attack.env <runner image> > <out>/attack.log 2>&1`
     Write the exit code to `<out>/attack.exit`. Do the same for `s16`.
  3. `podman run --rm --network none -v ${PWD}:/repo:ro -v <out>:/out:ro --entrypoint node <runner image> /repo/tools/emergency/runner-attack-check.ts judge /out`

- The H4 admission check, against a disposable API server where the chart is installed (it creates and deletes Jobs, and with `--negative-control` briefly removes the policy binding and the namespace's dedicated label; never run it against a cluster in use):
  `node --disable-warning=ExperimentalWarning tools/emergency/admission-check.ts --server https://<api server> --token-file <cluster-admin token file> --ca <ca file> --pods --negative-control`.
  `--reproduce` shows the finding instead: which malicious Jobs the executor's RBAC accepts without the policy. As tested on 2026-11-02, the API server was a throwaway etcd, kube-apiserver and kube-controller-manager in one Podman pod (images from `registry.k8s.io`), separate from both minikube profiles.

**Local OpenID Connect provider** (development only; it signs in any listed user without a password): `node --disable-warning=ExperimentalWarning tools/emergency/dev-oidc.ts --port 9400 --redirect-uri <the executor's callback URL>`, with `auth.oidc.issuer=http://127.0.0.1:9400` and `auth.oidc.allowInsecureHttp=true`. The executor must be able to reach it.

**Migrating from the shared operator token** (security review H2):
1. **Configure sign-in.** Register the executor with the identity provider, with redirect URI `https://<host><basePath>api/emergency/auth/callback`. Set `auth.oidc` and, from your own sign-in, `auth.initialAdministrators` (the emergency view shows your issuer and subject once signed in; a first sign-in with no roles is harmless). Upgrade.
2. **Assign roles.** Have users sign in once, then assign roles on the **Administration** page.
3. **The old token.** It stops working as an API token at the upgrade; its Secret is kept. Listing a break-glass account named `operator-token` keeps it usable as one break-glass credential during the transition. Remove that account once everyone signs in individually.
4. **Existing snapshots and executions** stay readable and runnable.
   - Snapshots without a preparer are shared and owned by no one: any operator can run them, only administrators can delete them.
   - Executions from before H2 show "the shared operator token" as their initiator.
   - Executions from H3 keep their verification key; older ones stay "not verifiable".
5. **Sessions and recovery.**
   - If the identity provider is unavailable, existing sessions keep working until they expire.
   - New sign-ins use break-glass accounts, configured beforehand, whose credentials cluster administrators read from the Secret (NOTES).
   - If everyone is locked out, a cluster administrator can set `auth.initialAdministrators` or break-glass accounts with Helm: Kubernetes access remains the root of trust.

**Remove:** `helm --kube-context gha-sec uninstall gha-emergency -n gha-emergency`. The data volume and break-glass credentials are kept; delete the namespace to remove everything, or the whole validation profile with `minikube delete -p gha-sec` (always with `-p`).
