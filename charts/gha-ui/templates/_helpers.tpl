{{/* Chart name, truncated to the 63 characters a label allows. */}}
{{- define "gha-ui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified name: the release name, with the chart name unless the release name already contains it. */}}
{{- define "gha-ui.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "gha-ui.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Selector labels: stable for the life of a release (a Deployment's selector cannot change). */}}
{{- define "gha-ui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gha-ui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "gha-ui.labels" -}}
helm.sh/chart: {{ include "gha-ui.chart" . }}
{{ include "gha-ui.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/component: frontend
app.kubernetes.io/part-of: github-actions-ui
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "gha-ui.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "gha-ui.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* repository:tag, or repository@digest when a digest is set. */}}
{{- define "gha-ui.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end }}
{{- end }}

{{/* The path the page is served under: "/" unless basePath is set. */}}
{{- define "gha-ui.basePath" -}}
{{- default "/" .Values.basePath }}
{{- end }}

{{- define "gha-ui.probe" -}}
httpGet:
  path: /healthz
  port: http
{{- with .probe }}
{{- range $k, $v := omit . "enabled" }}
{{ $k }}: {{ $v }}
{{- end }}
{{- end }}
{{- end }}
