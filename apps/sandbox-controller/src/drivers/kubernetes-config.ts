import { SbxConfigInvalidError } from '../errors.js';
import { MANAGED_BY } from './docker-config.js';

import type { KubernetesHardening } from '../spec/hardening.js';
import type { SandboxSpec } from '@blackwing/contracts';
import type {
  V1Container,
  V1Pod,
  V1SecurityContext,
  V1Volume,
  V1VolumeMount,
} from '@kubernetes/client-node';

/** Pod labels that drive the reaper (SANDBOX-011), the kill (SANDBOX-014) and tenant scoping (§8.6). */
export const KUBE_LABEL = {
  sandboxId: 'bw/sandbox-id',
  runId: 'bw/run-id',
  tenantId: 'bw/tenant-id',
  sessionId: 'bw/session-id',
  persona: 'bw/persona',
  managedBy: 'bw/managed-by',
} as const;

export const KUBE_ANNOTATION = {
  ttlExpiresAt: 'bw/ttl-expires-at',
} as const;

/**
 * Scheduling gate that keeps a freshly created sandbox Pod unscheduled until `start` removes it. This
 * gives the Kubernetes driver the same create-then-start contract as Docker.
 */
export const START_GATE = 'blackwing.io/sandbox-start';

/** The one OCI handler a sandbox may run under (§1.1, §8.9). There is no fallback to `runc`. */
export const RUNTIME_HANDLER = 'runsc';
export const CONTAINER_NAME = 'sandbox';

const MS_PER_SECOND = 1000;
const VOLUME_DEFAULT_MODE = 0o440;
const K8S_OBJECT_NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const SOURCE_REF = /^(secret|configmap):\/\/(.+)$/;

/** Pod name of one sandbox. Deterministic, so every lookup by `sandboxId` is a direct read. */
export function podName(sandboxId: string): string {
  return `sbx-${sandboxId}`;
}

export interface RenderPodOptions {
  readonly namespace: string;
  readonly now: Date;
  /** SANDBOX-007 fragment for this sandbox: security context, resources and default tmpfs volumes. */
  readonly hardening: KubernetesHardening;
  /** Largest size (MiB) a spec tmpfs mount may request: the resolved workspace size from SANDBOX-007. */
  readonly tmpfsCapMiB: number;
}

/**
 * Parses a mount source reference into a Kubernetes volume. Only namespaced `secret://<name>` and
 * `configmap://<name>` objects are bindable. Host paths, projected service-account tokens and any other
 * scheme are refused (fail closed, §8.7).
 */
function volumeForSource(volumeName: string, ref: string): V1Volume {
  const match = SOURCE_REF.exec(ref);
  const objectName = match?.[2] ?? '';
  if (match === null || !K8S_OBJECT_NAME.test(objectName)) {
    throw new SbxConfigInvalidError(
      'mount source must be secret://<name> or configmap://<name> for the kubernetes driver',
      ['mounts'],
    );
  }
  return match[1] === 'secret'
    ? { name: volumeName, secret: { secretName: objectName, defaultMode: VOLUME_DEFAULT_MODE } }
    : { name: volumeName, configMap: { name: objectName, defaultMode: VOLUME_DEFAULT_MODE } };
}

function containerSecurity(hardening: KubernetesHardening): V1SecurityContext {
  const sc = hardening.securityContext;
  return {
    privileged: sc.privileged,
    allowPrivilegeEscalation: sc.allowPrivilegeEscalation,
    readOnlyRootFilesystem: sc.readOnlyRootFilesystem,
    runAsNonRoot: sc.runAsNonRoot,
    runAsUser: sc.runAsUser,
    runAsGroup: sc.runAsGroup,
    capabilities: { drop: [...sc.capabilities.drop] },
    seccompProfile: {
      type: sc.seccompProfile.type,
      localhostProfile: sc.seccompProfile.localhostProfile,
    },
  };
}

/**
 * Pure `SandboxSpec` -> Pod manifest. Nothing here touches the cluster, so the hardening can be asserted
 * directly. The security context, resource limits and default `/workspace` and `/tmp` tmpfs volumes come
 * from the SANDBOX-007 builder (`spec/hardening.ts`), the single source of truth shared with the Docker
 * driver. The Pod adds the Kubernetes-only isolation: no service-account token, no service links, no host
 * namespaces, `restartPolicy: Never`, a digest-pinned image, and a lifetime bounded by the TTL.
 */
export function renderPod(spec: SandboxSpec, opts: RenderPodOptions): V1Pod {
  const { hardening } = opts;
  const specTargets = new Set(spec.mounts.map((mount) => mount.target));

  // Builder defaults first, except a default path that the spec mounts itself (the spec's volume wins).
  const volumes: V1Volume[] = [];
  const volumeMounts: V1VolumeMount[] = [];
  for (const mount of hardening.volumeMounts) {
    if (specTargets.has(mount.mountPath)) continue;
    const volume = hardening.volumes.find((candidate) => candidate.name === mount.name);
    if (volume === undefined) continue;
    volumes.push({ name: volume.name, emptyDir: { ...volume.emptyDir } });
    volumeMounts.push({ name: mount.name, mountPath: mount.mountPath, readOnly: false });
  }

  spec.mounts.forEach((mount, index) => {
    const name = `mount-${String(index)}`;
    if (mount.kind === 'tmpfs') {
      // Memory-backed, so the requested size is capped to the SANDBOX-007 resolved workspace size.
      const size = Math.min(mount.sizeMiB ?? opts.tmpfsCapMiB, opts.tmpfsCapMiB);
      volumes.push({ name, emptyDir: { medium: 'Memory', sizeLimit: `${String(size)}Mi` } });
      volumeMounts.push({ name, mountPath: mount.target, readOnly: mount.readOnly });
    } else {
      volumes.push(volumeForSource(name, mount.source));
      volumeMounts.push({ name, mountPath: mount.target, readOnly: true });
    }
  });

  const container: V1Container = {
    name: CONTAINER_NAME,
    image: spec.imageDigest,
    imagePullPolicy: 'IfNotPresent',
    env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
    resources: {
      requests: { ...hardening.resources.requests },
      limits: { ...hardening.resources.limits },
    },
    securityContext: containerSecurity(hardening),
    volumeMounts,
  };

  const sc = hardening.securityContext;
  const expires = new Date(opts.now.getTime() + spec.ttlSeconds * MS_PER_SECOND).toISOString();
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName(spec.sandboxId),
      namespace: opts.namespace,
      labels: {
        [KUBE_LABEL.sandboxId]: spec.sandboxId,
        [KUBE_LABEL.runId]: spec.runId,
        [KUBE_LABEL.tenantId]: spec.tenantId,
        [KUBE_LABEL.sessionId]: spec.sessionId,
        [KUBE_LABEL.persona]: spec.persona,
        [KUBE_LABEL.managedBy]: MANAGED_BY,
      },
      annotations: { [KUBE_ANNOTATION.ttlExpiresAt]: expires },
    },
    spec: {
      runtimeClassName: spec.runtimeClass,
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      activeDeadlineSeconds: spec.ttlSeconds,
      schedulingGates: [{ name: START_GATE }],
      securityContext: {
        runAsNonRoot: sc.runAsNonRoot,
        runAsUser: sc.runAsUser,
        runAsGroup: sc.runAsGroup,
        seccompProfile: {
          type: sc.seccompProfile.type,
          localhostProfile: sc.seccompProfile.localhostProfile,
        },
      },
      containers: [container],
      volumes,
    },
  };
}
