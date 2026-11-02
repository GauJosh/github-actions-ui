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

{{/* The cluster-scoped admission policy and binding, named after the release and its namespace (security review H4). */}}
{{- define "gha-emergency.admissionPolicy" -}}
{{- printf "%s-runner-jobs.%s" (include "gha-emergency.fullname" .) .Release.Namespace }}
{{- end }}

{{/* Network mode label of runner pods (job-spec.ts NETWORK_LABEL), selected by networkpolicy.yaml. */}}
{{- define "gha-emergency.networkLabel" -}}
gha-emergency.github-actions-ui/network
{{- end }}
