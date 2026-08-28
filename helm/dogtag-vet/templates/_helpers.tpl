{{- define "dogtag-vet.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "dogtag-vet.fullname" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "dogtag-vet.labels" -}}
app.kubernetes.io/name: {{ include "dogtag-vet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "dogtag-vet.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dogtag-vet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "dogtag-vet.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "dogtag-vet.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name | default "default" -}}
{{- end -}}
{{- end -}}

{{- define "dogtag-vet.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secrets" (include "dogtag-vet.fullname" .)) -}}
{{- end -}}
