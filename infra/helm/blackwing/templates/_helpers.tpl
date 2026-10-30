{{/*
Labels shared by every object in the umbrella chart. Values are plain lines so callers indent them.
*/}}
{{- define "bw.labels" -}}
app.kubernetes.io/part-of: blackwing
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
The only way a template names an image. The ref comes from global.images.<app> (CI-007 images.json
hand-off) and must be a digest-pinned ref; `required` fails the render when it is missing or empty.
Usage: include "bw.image" (dict "root" $ "name" "api")
*/}}
{{- define "bw.image" -}}
{{- $ref := index .root.Values.global.images .name -}}
{{- required (printf "global.images.%s is required: populate it from the CI-007 images.json hand-off (node scripts/helm-images.mjs), never from a tag" .name) $ref -}}
{{- end -}}

{{/*
The numeric container port behind a named port of an app. Usage: include "bw.port" (dict "app" $app "name" "mgmt")
*/}}
{{- define "bw.port" -}}
{{- range .app.ports -}}
{{- if eq .name $.name }}{{ .port }}{{ end -}}
{{- end -}}
{{- end -}}

{{/*
The ConfigMap data of one app: release-wide values, the app's own non-secret env, and extra
non-secret entries a template passes in. The migration hook reuses it so both objects see the same
configuration. Usage: include "bw.configData" (dict "root" $ "name" "api" "app" $app "extraEnv" $extra)
*/}}
{{- define "bw.configData" -}}
BW_ENVIRONMENT: {{ .root.Values.global.environment | quote }}
OTEL_SERVICE_NAME: {{ .name | quote }}
OTEL_EXPORTER_OTLP_ENDPOINT: {{ .root.Values.global.otel.endpoint | quote }}
{{- range $k, $v := .app.env }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- range $k, $v := .extraEnv }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- end -}}
