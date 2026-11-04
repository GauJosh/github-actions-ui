{{- define "gha-emergency.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/* Labels of the executor pod. Runner Jobs use them for pod affinity (deploy/emergency/executor/job-spec.ts). */}}
{{- define "gha-emergency.executorSelector" -}}
app.kubernetes.io/name: gha-emergency
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: executor
{{- end }}

{{- define "gha-emergency.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/part-of: github-actions-ui
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{- define "gha-emergency.tokenSecret" -}}
{{- default (printf "%s-operator" (include "gha-emergency.fullname" .)) .Values.operatorToken.existingSecret }}
{{- end }}

{{/* The runner image by digest (security review H4): the only image runner Jobs may use. */}}
{{- define "gha-emergency.runnerImage" -}}
{{- $digest := toString .Values.runner.image.digest }}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) }}
{{- fail "runner.image.digest must be the runner image's digest (sha256:<64 hex digits>): runner Jobs are pinned to it (security review H4)" }}
{{- end }}
{{- printf "%s@%s" .Values.runner.image.repository $digest }}
{{- end }}

{{/*
The executor image by digest (security review M7). The executor is the privileged component: it creates runner Jobs,
holds the service-account token and reads snapshots. A mutable tag (e.g. :local) with imagePullPolicy IfNotPresent
lets the content behind that tag change, or a stale/pre-planted image already cached under the name run, so what the
privileged executor runs is not fixed. Pinning it to an immutable digest removes both (a digest is content-addressed,
so IfNotPresent is safe). Fails the install (fail closed) when no valid digest is given.
*/}}
{{- define "gha-emergency.executorImage" -}}
{{- $digest := toString .Values.executor.image.digest }}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) }}
{{- fail "executor.image.digest must be the executor image's digest (sha256:<64 hex digits>): the privileged executor is pinned to it so a mutable tag can't change what it runs (security review M7)" }}
{{- end }}
{{- printf "%s@%s" .Values.executor.image.repository $digest }}
{{- end }}

{{/* The cluster-scoped admission policy and binding, named after the release and its namespace (security review H4). */}}
{{- define "gha-emergency.admissionPolicy" -}}
{{- printf "%s-runner-jobs.%s" (include "gha-emergency.fullname" .) .Release.Namespace }}
{{- end }}

{{/* Network mode label of runner pods (job-spec.ts NETWORK_LABEL), selected by networkpolicy.yaml. */}}
{{- define "gha-emergency.networkLabel" -}}
gha-emergency.github-actions-ui/network
{{- end }}

{{/*
Runner isolation (security review M4), validated here and passed to the executor as GHA_EMERGENCY_RUNNER_ISOLATION;
the admission policy pins the same placement. Fails the install (fail closed) on an invalid or unsupported mode.
*/}}
{{- define "gha-emergency.runnerIsolation" -}}
{{- $i := .Values.runner.isolation | default (dict "mode" "colocated") }}
{{- $mode := $i.mode | default "colocated" }}
{{- if not (has $mode (list "colocated" "sandbox" "node")) }}{{ fail (printf "runner.isolation.mode must be colocated, sandbox or node (got %q)" $mode) }}{{ end }}
{{- if and (eq $mode "sandbox") (not $i.runtimeClass) }}{{ fail "runner.isolation.mode \"sandbox\" needs runner.isolation.runtimeClass (a sandboxed RuntimeClass such as gvisor or kata)" }}{{ end }}
{{- if eq $mode "node" }}
{{- if not $i.nodeSelector }}{{ fail "runner.isolation.mode \"node\" needs runner.isolation.nodeSelector for the runner node pool" }}{{ end }}
{{- fail "runner.isolation.mode \"node\" needs snapshot storage reachable from another node (ReadWriteMany), which this chart does not configure. Use mode: sandbox, or provide cross-node storage first (security review M4)." }}
{{- end }}
{{- $out := dict "mode" $mode }}
{{- if and $i.runtimeClass (ne $mode "colocated") }}{{ $_ := set $out "runtimeClass" $i.runtimeClass }}{{ end }}
{{- if and (eq $mode "node") $i.nodeSelector }}{{ $_ := set $out "nodeSelector" $i.nodeSelector }}{{ end }}
{{- if and (eq $mode "node") $i.tolerations }}{{ $_ := set $out "tolerations" $i.tolerations }}{{ end }}
{{- $out | toJson }}
{{- end }}
