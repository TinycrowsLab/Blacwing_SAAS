import { describe, expect, it } from 'vitest';

import { DEFAULT_SANDBOX_WORKSPACE_MIB } from '../config.js';
import { SbxConfigInvalidError } from '../errors.js';
import {
  CONTAINER_NAME,
  KUBE_ANNOTATION,
  KUBE_LABEL,
  podName,
  renderPod,
  START_GATE,
} from './kubernetes-config.js';
import {
  BUILT_IN_HARDENING_CONFIG,
  buildKubernetesHardening,
  HARDENING,
  type HardeningRequest,
} from '../spec/hardening.js';

import type { SandboxSpec } from '@blackwing/contracts';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const SESSION = '01920000-0000-7000-8000-000000000003';
const SANDBOX = '01920000-0000-7000-8000-000000000004';
const NOW = new Date('2026-10-20T10:00:00.000Z');
const DIGEST = `bw-sandbox@sha256:${'c'.repeat(64)}`;
const SECCOMP = { type: 'Localhost', localhostProfile: HARDENING.seccompProfileName };

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: SANDBOX,
    runId: RUN,
    tenantId: TENANT,
    sessionId: SESSION,
    persona: 'active-recon',
    imageDigest: DIGEST,
    runtimeClass: 'gvisor',
    network: { runId: RUN, networkId: `bw-run-${RUN}` },
    resources: { cpu: 0.5, memoryMiB: 512, pids: 128 },
    env: { FOO: 'bar' },
    mounts: [
      { kind: 'tmpfs', target: '/workspace', readOnly: false, sizeMiB: 64 },
      { kind: 'inputs', source: 'secret://run-inputs', target: '/inputs', readOnly: true },
    ],
    ttlSeconds: 600,
    caBundleRef: 'openbao://pki/run/ca',
    ...overrides,
  };
}

/** Renders with the SANDBOX-007 builder and built-in defaults, as the driver does. */
function render(s: SandboxSpec = spec(), tmpfsCapMiB = DEFAULT_SANDBOX_WORKSPACE_MIB) {
  const request: HardeningRequest = { persona: s.persona, resources: s.resources };
  return renderPod(s, {
    namespace: 'bw-runs',
    now: NOW,
    hardening: buildKubernetesHardening(request, { config: BUILT_IN_HARDENING_CONFIG }),
    tmpfsCapMiB,
  });
}

describe('renderPod', () => {
  it('pins the runtime class, the digest and the no-restart policy', () => {
    const pod = render();
    expect(pod.metadata?.name).toBe(podName(SANDBOX));
    expect(pod.metadata?.namespace).toBe('bw-runs');
    expect(pod.spec?.runtimeClassName).toBe('gvisor');
    expect(pod.spec?.restartPolicy).toBe('Never');
    expect(pod.spec?.containers[0]?.image).toBe(DIGEST);
    expect(pod.spec?.containers[0]?.name).toBe(CONTAINER_NAME);
  });

  it('never mounts a service-account token nor service links, and no host namespaces', () => {
    const pod = render();
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
    expect(pod.spec?.enableServiceLinks).toBe(false);
    expect(pod.spec?.hostNetwork).toBe(false);
    expect(pod.spec?.hostPID).toBe(false);
    expect(pod.spec?.hostIPC).toBe(false);
  });

  it('takes the container security context from the SANDBOX-007 builder', () => {
    const pod = render();
    expect(pod.spec?.containers[0]?.securityContext).toEqual({
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: HARDENING.user.uid,
      runAsGroup: HARDENING.user.gid,
      capabilities: { drop: ['ALL'] },
      seccompProfile: SECCOMP,
    });
  });

  it('never runs as root and never runs unconfined', () => {
    const pod = render();
    expect(HARDENING.user.uid).not.toBe(0);
    expect(pod.spec?.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: HARDENING.user.uid,
      runAsGroup: HARDENING.user.gid,
      seccompProfile: SECCOMP,
    });
    expect(JSON.stringify(pod)).not.toContain('Unconfined');
    expect(JSON.stringify(pod)).not.toContain('"privileged":true');
  });

  it('sets CPU and memory requests and limits to the builder-resolved values', () => {
    const resources = render().spec?.containers[0]?.resources;
    expect(resources?.limits).toEqual({ cpu: '0.5', memory: '512Mi' });
    expect(resources?.requests).toEqual({ cpu: '0.5', memory: '512Mi' });
  });

  it('carries the sandbox taxonomy as labels and the TTL as an annotation', () => {
    const pod = render();
    expect(pod.metadata?.labels).toEqual({
      [KUBE_LABEL.sandboxId]: SANDBOX,
      [KUBE_LABEL.runId]: RUN,
      [KUBE_LABEL.tenantId]: TENANT,
      [KUBE_LABEL.sessionId]: SESSION,
      [KUBE_LABEL.persona]: 'active-recon',
      [KUBE_LABEL.managedBy]: 'blackwing-sandbox-controller',
    });
    expect(pod.metadata?.annotations).toEqual({
      [KUBE_ANNOTATION.ttlExpiresAt]: '2026-10-20T10:10:00.000Z',
    });
  });

  it('bounds the Pod lifetime by the sandbox TTL', () => {
    expect(render().spec?.activeDeadlineSeconds).toBe(600);
  });

  it('holds the Pod behind the start gate so create does not start it', () => {
    expect(render().spec?.schedulingGates).toEqual([{ name: START_GATE }]);
  });

  it('keeps the builder /tmp volume and maps the spec workspace and inputs to their volumes', () => {
    const pod = render();
    expect(pod.spec?.volumes).toEqual([
      {
        name: 'tmp',
        emptyDir: { medium: 'Memory', sizeLimit: `${String(HARDENING.tmpSizeMiB)}Mi` },
      },
      { name: 'mount-0', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } },
      { name: 'mount-1', secret: { secretName: 'run-inputs', defaultMode: 0o440 } },
    ]);
    expect(pod.spec?.containers[0]?.volumeMounts).toEqual([
      { name: 'tmp', mountPath: HARDENING.tmpPath, readOnly: false },
      { name: 'mount-0', mountPath: '/workspace', readOnly: false },
      { name: 'mount-1', mountPath: '/inputs', readOnly: true },
    ]);
  });

  it('caps a spec tmpfs at the SANDBOX-007 resolved workspace size', () => {
    const pod = render(
      spec({ mounts: [{ kind: 'tmpfs', target: '/data', readOnly: false, sizeMiB: 4096 }] }),
      128,
    );
    expect(pod.spec?.volumes?.find((v) => v.name === 'mount-0')).toEqual({
      name: 'mount-0',
      emptyDir: { medium: 'Memory', sizeLimit: '128Mi' },
    });
  });

  it('uses the spec volume in place of a builder default when the spec mounts the same path', () => {
    const pod = render(
      spec({ mounts: [{ kind: 'tmpfs', target: '/tmp', readOnly: true, sizeMiB: 16 }] }),
    );
    const tmpMounts = pod.spec?.containers[0]?.volumeMounts?.filter((m) => m.mountPath === '/tmp');
    expect(tmpMounts).toEqual([{ name: 'mount-0', mountPath: '/tmp', readOnly: true }]);
  });

  it('adds the default workspace when the spec mounts nothing', () => {
    const pod = render(spec({ mounts: [] }));
    expect(pod.spec?.volumes).toEqual([
      {
        name: 'workspace',
        emptyDir: { medium: 'Memory', sizeLimit: `${String(DEFAULT_SANDBOX_WORKSPACE_MIB)}Mi` },
      },
      {
        name: 'tmp',
        emptyDir: { medium: 'Memory', sizeLimit: `${String(HARDENING.tmpSizeMiB)}Mi` },
      },
    ]);
  });

  it('renders CA and source mounts as configmaps when referenced that way', () => {
    const pod = render(
      spec({
        mounts: [{ kind: 'ca', source: 'configmap://run-ca', target: '/ca', readOnly: true }],
      }),
    );
    expect(pod.spec?.volumes?.find((v) => v.name === 'mount-0')).toEqual({
      name: 'mount-0',
      configMap: { name: 'run-ca', defaultMode: 0o440 },
    });
  });

  it('refuses host paths and any other source scheme (no hostPath, no projected tokens)', () => {
    for (const source of [
      'file:///var/run/docker.sock',
      'hostpath:///var/lib',
      'openbao://pki/run/ca',
      'secret://../etc',
      'secret://Upper',
      'secret://a/b',
    ]) {
      expect(() =>
        render(spec({ mounts: [{ kind: 'inputs', source, target: '/inputs', readOnly: true }] })),
      ).toThrow(SbxConfigInvalidError);
    }
  });

  it('never renders a host path volume', () => {
    for (const volume of render().spec?.volumes ?? []) {
      expect(volume).not.toHaveProperty('hostPath');
    }
  });

  it('passes the sandbox env through as plain name/value pairs', () => {
    expect(render().spec?.containers[0]?.env).toEqual([{ name: 'FOO', value: 'bar' }]);
  });
});
