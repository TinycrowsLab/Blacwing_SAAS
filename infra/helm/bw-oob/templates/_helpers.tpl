{{- define "bw-oob.name" -}}
bw-oob
{{- end -}}

{{- define "bw-oob.labels" -}}
app.kubernetes.io/name: {{ include "bw-oob.name" . }}
app.kubernetes.io/part-of: blackwing
app.kubernetes.io/component: oob-listener
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "bw-oob.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bw-oob.name" . }}
app.kubernetes.io/part-of: blackwing
{{- end -}}

{{- define "bw-oob.image" -}}
{{- printf "%s:%s@%s" .Values.image.repository .Values.image.tag .Values.image.digest -}}
{{- end -}}

{{- define "bw-oob.fqdn" -}}
{{- printf "%s.%s" .Values.oobLabel .Values.domain -}}
{{- end -}}

{{- /* Fails closed: the listener cannot be installed without a public address, a domain, a token Secret and an ops-approved image digest. */ -}}
{{- define "bw-oob.validate" -}}
{{- if not .Values.domain -}}
{{- fail "bw-oob: domain is required (the app domain that delegates oob.<domain>)" -}}
{{- end -}}
{{- if not (regexMatch "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$" .Values.domain) -}}
{{- fail (printf "bw-oob: domain %q is not a valid DNS name" .Values.domain) -}}
{{- end -}}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" .Values.oobLabel) -}}
{{- fail "bw-oob: oobLabel must be one lower-case DNS label (no dots)" -}}
{{- end -}}
{{- if not .Values.publicIP -}}
{{- fail "bw-oob: publicIP is required (one public IPv4 address from tofu oob_server_ips)" -}}
{{- end -}}
{{- if not (regexMatch "^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$" .Values.publicIP) -}}
{{- fail (printf "bw-oob: publicIP %q is not an IPv4 address" .Values.publicIP) -}}
{{- end -}}
{{- if regexMatch "^(0\\.|10\\.|127\\.|169\\.254\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|22[4-9]\\.|2[3-5][0-9]\\.)" .Values.publicIP -}}
{{- fail (printf "bw-oob: publicIP %q is private, loopback, link-local or multicast; the OOB listener must be Internet-reachable" .Values.publicIP) -}}
{{- end -}}
{{- if not .Values.existingSecret -}}
{{- fail "bw-oob: existingSecret is required (a Secret with key `token`, synced from OpenBao; the token is never set in values)" -}}
{{- end -}}
{{- if not .Values.image.digest -}}
{{- fail "bw-oob: image.digest is required; the server is pinned by digest (CONTEXT_PACK §8.9)" -}}
{{- end -}}
{{- if not .Values.placement.nodeSelector -}}
{{- fail "bw-oob: placement.nodeSelector is required; hostPort listeners need a node that does not run Traefik" -}}
{{- end -}}
{{- end -}}
