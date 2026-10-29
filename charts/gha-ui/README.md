# gha-ui Helm chart

This chart deploys the GitHub Actions UI frontend: the image from [`deploy/ui/Dockerfile`](../../deploy/ui/README.md), a Node static server serving the production build.

It contains only a Deployment, a Service, a ServiceAccount with no permissions, and a `helm test` pod. It has no backend, Ingress or Gateway, and creates no RBAC or NetworkPolicy.

The UI runs in the user's browser and calls `https://api.github.com` directly, read-only, with a token the user enters. The token stays in that browser tab's memory. It never reaches the pod or the cluster.

## Prerequisites

- Kubernetes 1.25 or later. Tested on Minikube 1.38 (Kubernetes 1.35, CRI-O, Podman driver).
- Helm 3. Tested with 3.13. The chart's `values.schema.json` uses Helm's built-in validation.
- The UI image, built from this repository. No image is published to a registry.

## Prepare the image

### Minikube, with no registry

Build the image under the chart's default name, `localhost/gha-ui:k1`. This is not the `gha-ui:local` example in `deploy/ui/README.md`. With Docker, `gha-ui:local` names a different image, and the chart would not find it.

**Podman** (tested: Podman 5.7, Minikube with the Podman driver and CRI-O). Save the image as an OCI archive, then load the archive into the cluster:

```sh
podman build -f deploy/ui/Dockerfile -t localhost/gha-ui:k1 .
podman save --format oci-archive -o gha-ui.tar localhost/gha-ui:k1
minikube image load gha-ui.tar
minikube ssh -- sudo crictl images | grep gha-ui                  # confirm the node has it
```

**Docker** (not tested). `docker save` has no `--format oci-archive`, so the archive step above is Podman-only. Load the image from the local Docker daemon instead:

```sh
docker build -f deploy/ui/Dockerfile -t localhost/gha-ui:k1 .
minikube image load localhost/gha-ui:k1
```

The chart's defaults (`localhost/gha-ui`, tag `k1`, `pullPolicy: IfNotPresent`) use this local image. If it is missing, the pod stays in `ErrImagePull` and the install times out.

Give each rebuild a new tag and pass it with `--set image.tag=...` (see "Upgrade and uninstall"). Loading a rebuilt image under the same tag does not restart running pods, because the Deployment does not change.

### Other clusters

Push the image to your registry under an immutable tag, then set it at install time:

```sh
--set image.repository=registry.example.com/team/gha-ui --set image.tag=2026.10.28-abc1234
--set image.digest=sha256:...                 # optional: pull by digest; the tag is then ignored
--set imagePullSecrets[0]=regcred             # an existing kubernetes.io/dockerconfigjson Secret
```

The tag `latest` is rejected.

## Install

The tested setup uses a dedicated namespace that enforces the "restricted" Pod Security Standard. The chart's pods meet it, including the test pod.

The `kubectl` and `helm` commands in this README act on your current kubeconfig context. Check it first with `kubectl config current-context`, or add `--context <name>` to `kubectl` and `--kube-context <name>` to `helm`, for example `minikube`.

```sh
kubectl create namespace gha-ui
kubectl label namespace gha-ui pod-security.kubernetes.io/enforce=restricted
helm install gha-ui charts/gha-ui --namespace gha-ui --wait
```

## Open it

```sh
kubectl --namespace gha-ui port-forward service/gha-ui 8080:80
# http://127.0.0.1:8080/  (or http://127.0.0.1:8080/gha-ui/ with basePath=/gha-ui/)
```

Port-forwarding is for local checks. Anywhere else, serve the UI over HTTPS, because users enter a GitHub token into the page.

## Root path or path prefix

One image serves at a host's root or under a prefix.

- `basePath` (empty by default, meaning `/`) sets `GHA_UI_BASE_PATH`.
- Use it only behind a proxy that forwards the prefix unchanged. A proxy that strips the prefix needs the default.
- A prefix must start and end with `/`, for example `/gha-ui/`.
- Probes and the test always use `/healthz` at the root, whatever the prefix.

```sh
helm install gha-ui-sub charts/gha-ui --namespace gha-ui --set basePath=/gha-ui/
```

In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` first. Otherwise Git Bash rewrites `/gha-ui/` into a Windows path, and the values schema rejects it.

## Configuration

| Value | Default | Notes |
|---|---|---|
| `image.repository`, `image.tag`, `image.digest`, `image.pullPolicy` | `localhost/gha-ui`, `k1`, `""`, `IfNotPresent` | See "Prepare the image" |
| `imagePullSecrets` | `[]` | Secret names |
| `replicaCount` | `1` | Stateless; any count works |
| `updateStrategy` | RollingUpdate, `maxUnavailable: 0`, `maxSurge: 1` | |
| `basePath` | `""` | See above |
| `containerPort` | `8080` | 1024 or above, because the container is not root |
| `service.type`, `service.port`, `service.nodePort` | `ClusterIP`, `80`, unset | |
| `resources` | requests 10m CPU / 32Mi; limits 250m CPU / 128Mi | Measured on Minikube: about 14 MiB once started |
| `startupProbe`, `livenessProbe`, `readinessProbe` | enabled, `GET /healthz` | Timings are configurable |
| `serviceAccount.create`, `.name`, `.annotations` | `true`, generated, `{}` | |
| `serviceAccount.automountServiceAccountToken` | `false` | Fixed: `true` is rejected. The UI never calls the Kubernetes API |
| `podSecurityContext`, `securityContext` | non-root UID/GID 1000, seccomp `RuntimeDefault`, read-only root filesystem, all capabilities dropped, no privilege escalation | See "Security" |
| `podAnnotations`, `podLabels`, `nodeSelector`, `tolerations`, `affinity` | empty | |
| `tests.image` | `docker.io/curlimages/curl:8.9.1` | The `helm test` image, pinned by tag |

Example:

```sh
helm upgrade gha-ui charts/gha-ui --namespace gha-ui --reuse-values \
  --set replicaCount=2 --set resources.limits.memory=256Mi --wait
```

## Test

```sh
helm test gha-ui --namespace gha-ui                        # "Phase: Succeeded" and exit code 0 on success
kubectl --namespace gha-ui logs gha-ui-test-health         # after a failure: what failed
```

Do not add `--logs`. A passing test pod is deleted as soon as it succeeds, so `helm test --logs` cannot fetch its logs, and it exits 1 even though the test passed (Helm 3.13).

The test pod uses curl through the release's Service, and accounts for `basePath`. It checks:
- `/healthz` returns 200;
- the page returns 200 with exactly one CSP header containing the essential directives, and none of the `unsafe-*` sources;
- `nosniff`, `no-referrer` and `no-cache` on the page;
- the page's script loads, with immutable caching;
- the log worker loads, with `connect-src 'none'`;
- unknown paths and fixture paths return 404.

It prints one line per check and fails with a non-zero exit code if any check fails. A passing test pod is deleted. A failing one stays, so you can read its output with `kubectl logs`, until the next run.

Exact header values are compared with their source when the image is checked (`deploy/ui/check-http.ts`), not here: the chart cannot read the application source.

The test image is pulled from Docker Hub unless the node already has it. If the image is unavailable, the test pod stays in `ErrImagePull` and `helm test` fails at its timeout. Pre-load it as for the UI image, or set `tests.image` to a mirror.

## Validation without a cluster

The CI job "Helm chart" (`.github/workflows/ci.yml`) runs these with a pinned, checksum-verified Helm, and so can you:

```sh
helm lint --strict charts/gha-ui
helm lint --strict charts/gha-ui --set basePath=/gha-ui/
helm template gha-ui charts/gha-ui > /dev/null
helm template gha-ui charts/gha-ui --set basePath=/gha-ui/ > /dev/null
node --disable-warning=ExperimentalWarning tools/chart/check-chart.ts
```

`tools/chart/check-chart.ts` renders the chart with several sets of supported values and checks the security and wiring invariants listed in ARCHITECTURE §11.14. It also confirms two things:
- the values schema refuses each unsafe override under "Security";
- each check catches a deliberately broken render.

## Upgrade and uninstall

```sh
helm upgrade gha-ui charts/gha-ui --namespace gha-ui --reuse-values --set image.tag=<new tag> --wait
helm rollback gha-ui --namespace gha-ui            # back to the previous revision
helm uninstall gha-ui --namespace gha-ui
kubectl delete namespace gha-ui                    # if it was created only for this release
```

## Security

- **Pod hardening:**
  - the pod runs as UID/GID 1000, the image's `node` user;
  - read-only root filesystem, with no volumes at all;
  - all capabilities dropped, no privilege escalation, seccomp `RuntimeDefault`;
  - no service-account token (`automountServiceAccountToken: false` on the pod and the ServiceAccount);
  - `enableServiceLinks: false`.
- **Guarded values:** `values.schema.json` rejects values that would weaken this:
  - `runAsNonRoot` false or removed, UID 0, `privileged`, `allowPrivilegeEscalation`, `readOnlyRootFilesystem` false;
  - added capabilities, or dropping less than `ALL`;
  - a mounted service-account token (`serviceAccount.automountServiceAccountToken: true`);
  - a seccomp profile of `Unconfined`, or removing the profile from both the pod and the container. Removing it from one of them is allowed;
  - a malformed seccomp profile. `RuntimeDefault` (the default) takes no `localhostProfile`. `Localhost` requires one: a path relative to the kubelet's seccomp directory, such as `profiles/gha-ui.json`, with no `..` segments. The profile must exist on every node;
  - any container `securityContext` key the chart does not list, such as `procMount`, `seLinuxOptions`, `windowsOptions` or `appArmorProfile`.
  - The UID may be changed, or set to `null` for platforms that assign one, such as OpenShift.
  - `podSecurityContext` keys other than the hardened ones are not restricted. Pod Security "restricted" admission covers that level.
- **No permissions:** the chart creates no Role, ClusterRole or binding.
- **Network:** the pod needs no outbound network; the image was checked with networking disabled. The chart adds no NetworkPolicy, because enforcement depends on the cluster's CNI.
- **What the page enforces:** the server sends the app's Content Security Policy. Its `connect-src` allows only the page's own origin, `api.github.com` and GitHub's log storage host (`*.blob.core.windows.net`). The policy and its known residual risk are recorded in the project architecture document, section 7.3.
- **Token handling:** the page is where users type a GitHub token. Whoever controls the image, or anything between the user and the pod (a proxy or CDN), can affect what the page does with it. Use HTTPS, trusted image sources and immutable tags or digests.

## Limitations

- **Images:** no published image, and no image signing or SBOM. Base images are pinned by tag, not digest (`deploy/ui/README.md`).
- **Testing:** only Minikube (Podman driver, CRI-O, amd64) was tested. kind, AKS, EKS and GKE are not yet.
- **Not in this chart:** external access (Ingress or Gateway API), a PodDisruptionBudget, autoscaling and NetworkPolicy.
