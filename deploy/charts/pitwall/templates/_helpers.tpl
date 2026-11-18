{{- define "pitwall.labels" -}}
app.kubernetes.io/part-of: pitwall
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
{{- end }}

{{- define "pitwall.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end }}
