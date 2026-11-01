{{/*
Common labels. Usage: include "bw-deps.labels" (dict "component" "postgres" "ctx" $)
*/}}
{{- define "bw-deps.labels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/part-of: blackwing
app.kubernetes.io/component: dependency
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
{{- end -}}

{{/*
Image reference. Fails closed unless the reference is pinned by a sha256 digest, so no tag can float into
a release. Usage: include "bw-deps.image" (dict "ref" .Values.images.postgres)
*/}}
{{- define "bw-deps.image" -}}
{{- if not (regexMatch "@sha256:[0-9a-f]{64}$" .ref) -}}
{{- fail (printf "image %q is not pinned by a sha256 digest (CONTEXT_PACK 8.9)" .ref) -}}
{{- end -}}
{{- .ref -}}
{{- end -}}

{{/*
Environment guard. Renders the environment after checking it is one of the known ones.
*/}}
{{- define "bw-deps.environment" -}}
{{- $env := required "global.environment is required (dev | staging | prod)" .Values.global.environment -}}
{{- if not (has $env (list "dev" "staging" "prod")) -}}
{{- fail (printf "global.environment %q must be dev, staging or prod" $env) -}}
{{- end -}}
{{- $env -}}
{{- end -}}

{{/*
Container security defaults shared by every dependency: no privilege escalation, no Linux capabilities,
no service-account token. Components that need a capability (postgres runs its entrypoint as root and
drops to the postgres user) override it in their own template.
*/}}
{{- define "bw-deps.securityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ['ALL']
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/*
Storage class stanza for a PVC spec. Empty value uses the cluster default.
*/}}
{{- define "bw-deps.storageClass" -}}
{{- if .Values.storageClassName }}
storageClassName: {{ .Values.storageClassName }}
{{- end }}
{{- end -}}

{{/*
Secret-backed env var. The chart never renders the Secret; a missing Secret stops the pod at creation.
Usage: include "bw-deps.secretEnv" (dict "name" "POSTGRES_PASSWORD" "secret" "bw-deps-postgres" "key" "superuser-password")
*/}}
{{- define "bw-deps.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      optional: false
{{- end -}}

{{/*
Resource stanza. Usage: include "bw-deps.resources" .Values.postgres.resources
*/}}
{{- define "bw-deps.resources" -}}
resources:
  {{- toYaml . | nindent 2 }}
{{- end -}}
