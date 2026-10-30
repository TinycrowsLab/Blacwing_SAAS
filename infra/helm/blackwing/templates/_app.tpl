{{/*
One long-running Blackwing app: ServiceAccount, ConfigMap, Deployment, Service, and optionally an HPA
and a PodDisruptionBudget. Hardening is the same for every app: non-root, read-only root filesystem,
no capabilities, RuntimeDefault seccomp, no ServiceAccount token unless the app needs one, and secrets
only through envFrom (optional: false, so a missing Secret blocks the pod).
Usage: include "bw.app" (dict "root" $ "name" "api" "extraEnv" (dict))
*/}}
{{- define "bw.app" -}}
{{- $root := .root -}}
{{- $name := .name -}}
{{- $app := index $root.Values.apps $name -}}
{{- $extra := .extraEnv | default (dict) -}}
{{- if $app.enabled }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ $name }}
  labels:
    {{- include "bw.labels" $root | nindent 4 }}
    app.kubernetes.io/name: {{ $name }}
    blackwing.io/component: {{ $name }}
automountServiceAccountToken: {{ $app.automountServiceAccountToken }}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ $name }}-config
  labels:
    {{- include "bw.labels" $root | nindent 4 }}
    app.kubernetes.io/name: {{ $name }}
    blackwing.io/component: {{ $name }}
data:
  {{- include "bw.configData" (dict "root" $root "name" $name "app" $app "extraEnv" $extra) | nindent 2 }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "bw.labels" $root | nindent 4 }}
    app.kubernetes.io/name: {{ $name }}
    blackwing.io/component: {{ $name }}
spec:
  {{- if not $app.hpa.enabled }}
  replicas: {{ $app.replicas }}
  {{- end }}
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ $root.Release.Name }}
      app.kubernetes.io/name: {{ $name }}
      blackwing.io/component: {{ $name }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    metadata:
      labels:
        {{- include "bw.labels" $root | nindent 8 }}
        app.kubernetes.io/name: {{ $name }}
        blackwing.io/component: {{ $name }}
      annotations:
        # Any change to the app's configuration or image rolls the pods.
        checksum/config: {{ dict "app" $app "global" $root.Values.global "extraEnv" $extra | toYaml | sha256sum | quote }}
        prometheus.io/scrape: "true"
        prometheus.io/path: /metrics
        prometheus.io/port: {{ include "bw.port" (dict "app" $app "name" $app.probePort) | quote }}
    spec:
      serviceAccountName: {{ $name }}
      automountServiceAccountToken: {{ $app.automountServiceAccountToken }}
      nodeSelector:
        blackwing.io/pool: {{ $app.pool }}
      securityContext:
        runAsNonRoot: true
        runAsUser: {{ $app.runAsUser }}
        runAsGroup: {{ $app.runAsUser }}
        seccompProfile:
          type: RuntimeDefault
      terminationGracePeriodSeconds: 30
      containers:
        - name: {{ $name }}
          image: {{ include "bw.image" (dict "root" $root "name" $name) | quote }}
          imagePullPolicy: IfNotPresent
          ports:
            {{- range $app.ports }}
            - name: {{ .name }}
              containerPort: {{ .port }}
              protocol: {{ .protocol | default "TCP" }}
            {{- end }}
          envFrom:
            - configMapRef:
                name: {{ $name }}-config
            - secretRef:
                name: {{ $app.secretName }}
                optional: false
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            capabilities:
              drop: ['ALL']
          resources:
            {{- toYaml $app.resources | nindent 12 }}
          startupProbe:
            httpGet:
              path: {{ $app.probes.liveness }}
              port: {{ $app.probePort }}
            periodSeconds: 2
            failureThreshold: 60
          livenessProbe:
            httpGet:
              path: {{ $app.probes.liveness }}
              port: {{ $app.probePort }}
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: {{ $app.probes.readiness }}
              port: {{ $app.probePort }}
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 2
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "bw.labels" $root | nindent 4 }}
    app.kubernetes.io/name: {{ $name }}
    blackwing.io/component: {{ $name }}
spec:
  # ClusterIP only. Public exposure happens in bw-ingress, and only for the paths it lists.
  type: ClusterIP
  selector:
    app.kubernetes.io/instance: {{ $root.Release.Name }}
    app.kubernetes.io/name: {{ $name }}
    blackwing.io/component: {{ $name }}
  ports:
    {{- range $app.ports }}
    - name: {{ .name }}
      port: {{ .port }}
      targetPort: {{ .name }}
      protocol: {{ .protocol | default "TCP" }}
    {{- end }}
{{- if $app.hpa.enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ $name }}
  labels:
    {{- include "bw.labels" $root | nindent 4 }}
    app.kubernetes.io/name: {{ $name }}
    blackwing.io/component: {{ $name }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ $name }}
  minReplicas: {{ $app.hpa.minReplicas }}
  maxReplicas: {{ $app.hpa.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ $app.hpa.targetCPUUtilizationPercentage }}
{{- end }}
{{- if $app.pdb.enabled }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $name }}
  labels:
    {{- include "bw.labels" $root | nindent 4 }}
    app.kubernetes.io/name: {{ $name }}
    blackwing.io/component: {{ $name }}
spec:
  minAvailable: {{ $app.pdb.minAvailable }}
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ $root.Release.Name }}
      app.kubernetes.io/name: {{ $name }}
      blackwing.io/component: {{ $name }}
{{- end }}
{{- end }}
{{- end -}}
