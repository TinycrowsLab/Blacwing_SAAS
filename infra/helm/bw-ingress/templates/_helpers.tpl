{{/* Validated inputs shared by every template (INFRA-012). */}}

{{- define "bw-ingress.domain" -}}
{{- required "domain is required (the Route53 app zone name, for example blackwing.example)" .Values.domain -}}
{{- end -}}

{{- define "bw-ingress.webHost" -}}
{{ .Values.web.host }}.{{ include "bw-ingress.domain" . }}
{{- end -}}

{{- define "bw-ingress.apiHost" -}}
{{ .Values.api.host }}.{{ include "bw-ingress.domain" . }}
{{- end -}}

{{- define "bw-ingress.labels" -}}
app.kubernetes.io/part-of: blackwing
app.kubernetes.io/component: ingress
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Fail closed on inputs that would weaken the ingress. Included once from validate.yaml. */}}
{{- define "bw-ingress.validate" -}}
{{- if not (has .Values.tls.issuer (list "letsencrypt-staging" "letsencrypt-prod")) -}}
{{- fail "tls.issuer must be letsencrypt-staging or letsencrypt-prod" -}}
{{- end -}}
{{- if lt (int .Values.headers.stsSeconds) 15552000 -}}
{{- fail "headers.stsSeconds must be at least 15552000 (180 days)" -}}
{{- end -}}
{{- if ne .Values.tls.minVersion "VersionTLS12" -}}
{{- if ne .Values.tls.minVersion "VersionTLS13" -}}
{{- fail "tls.minVersion must be VersionTLS12 or VersionTLS13" -}}
{{- end -}}
{{- end -}}
{{- range .Values.tls.cipherSuites -}}
{{- if or (not (contains "ECDHE" .)) (contains "_CBC_" .) (contains "_RC4_" .) (contains "_3DES_" .) -}}
{{- fail (printf "tls.cipherSuites contains a weak or non-forward-secret suite: %s" .) -}}
{{- end -}}
{{- end -}}
{{- if empty .Values.api.publicPaths -}}
{{- fail "api.publicPaths must list at least one path" -}}
{{- end -}}
{{- range .Values.api.publicPaths -}}
{{- if not (hasPrefix "/" .) -}}
{{- fail (printf "api.publicPaths entry %q must start with /" .) -}}
{{- end -}}
{{- if or (hasPrefix "/internal" .) (contains "broker" (lower .)) (eq . "/") -}}
{{- fail (printf "api.publicPaths entry %q would expose the internal Run Broker surface or the whole API; broker paths are served on a cluster-internal Service only" .) -}}
{{- end -}}
{{- end -}}
{{- range $name, $ui := .Values.internalUis -}}
{{- if $ui.enabled -}}
{{- if empty $ui.ipAllowList -}}
{{- fail (printf "internalUis.%s: ipAllowList is required; internal UIs are never public" $name) -}}
{{- end -}}
{{- range $ui.ipAllowList -}}
{{- if or (eq . "0.0.0.0/0") (eq . "::/0") -}}
{{- fail (printf "internalUis.%s: ipAllowList must not allow every address" $name) -}}
{{- end -}}
{{- end -}}
{{- if empty $ui.authMiddleware -}}
{{- fail (printf "internalUis.%s: authMiddleware is required; internal UIs are never anonymous" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
