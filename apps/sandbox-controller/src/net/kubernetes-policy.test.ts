import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { renderRunNetworkPolicies, runNetworkId, runPolicyNames } from './kubernetes-policy.js';
import { KUBE_LABEL } from '../drivers/kubernetes-config.js';

import type { RunNetworkSpec } from '@blackwing/contracts';

const TENANT = '01920000-0000-7000-8000-000000000001';
const RUN = '01920000-0000-7000-8000-000000000002';
const NS = 'bw-runs';

function spec(overrides: Partial<RunNetworkSpec> = {}): RunNetworkSpec {
  return {
    runId: RUN,
    tenantId: TENANT,
    driver: 'kubernetes',
    allowedDestinations: [
      { kind: 'egress-gateway', host: 'egress-gateway', port: 13128 },
      { kind: 'model-gateway', host: 'model-gateway', port: 13500 },
      { kind: 'run-broker', host: 'run-broker', port: 13400 },
    ],
    ...overrides,
  };
}

describe('renderRunNetworkPolicies', () => {
  it('names both policies after the run network', () => {
    const { defaultDeny, egress } = renderRunNetworkPolicies(spec(), NS);
    expect(runNetworkId(RUN)).toBe(`bw-run-${RUN}`);
    expect(defaultDeny.metadata?.name).toBe(`bw-run-${RUN}-default-deny`);
    expect(egress.metadata?.name).toBe(`bw-run-${RUN}-egress`);
    expect(runPolicyNames(RUN)).toEqual({
      defaultDeny: `bw-run-${RUN}-default-deny`,
      egress: `bw-run-${RUN}-egress`,
    });
    expect(defaultDeny.metadata?.namespace).toBe(NS);
    expect(egress.metadata?.namespace).toBe(NS);
  });

  it('labels both policies with the run, tenant and manager (scope for teardown and audit)', () => {
    const { defaultDeny, egress } = renderRunNetworkPolicies(spec(), NS);
    for (const policy of [defaultDeny, egress]) {
      expect(policy.metadata?.labels).toMatchObject({
        [KUBE_LABEL.runId]: RUN,
        [KUBE_LABEL.tenantId]: TENANT,
        [KUBE_LABEL.managedBy]: 'blackwing-sandbox-controller',
      });
    }
  });

  it('default-deny selects only this run and denies all ingress and egress (no rules)', () => {
    const { defaultDeny } = renderRunNetworkPolicies(spec(), NS);
    expect(defaultDeny.spec?.podSelector).toEqual({ matchLabels: { [KUBE_LABEL.runId]: RUN } });
    expect(defaultDeny.spec?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(defaultDeny.spec?.ingress).toBeUndefined();
    expect(defaultDeny.spec?.egress).toBeUndefined();
  });

  it('egress allow permits exactly the declared Services on their ports, scoped to the run', () => {
    const { egress } = renderRunNetworkPolicies(spec(), NS);
    expect(egress.spec?.podSelector).toEqual({ matchLabels: { [KUBE_LABEL.runId]: RUN } });
    expect(egress.spec?.policyTypes).toEqual(['Egress']);
    expect(egress.spec?.ingress).toBeUndefined();
    const [gateway, model, broker] = egress.spec?.egress ?? [];
    expect(gateway).toEqual({
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'bw-system' } },
          podSelector: { matchLabels: { 'app.kubernetes.io/name': 'egress-gateway' } },
        },
      ],
      ports: [{ protocol: 'TCP', port: 13128 }],
    });
    expect(model?.to?.[0]?.podSelector).toEqual({
      matchLabels: { 'app.kubernetes.io/name': 'model-gateway' },
    });
    expect(model?.ports).toEqual([{ protocol: 'TCP', port: 13500 }]);
    expect(broker?.to?.[0]?.podSelector).toEqual({
      matchExpressions: [
        { key: 'app.kubernetes.io/name', operator: 'In', values: ['api', 'run-broker'] },
      ],
    });
    expect(broker?.ports).toEqual([{ protocol: 'TCP', port: 13400 }]);
  });

  it('allows DNS to kube-dns only, on 53 over UDP and TCP (no open resolver)', () => {
    const { egress } = renderRunNetworkPolicies(spec(), NS);
    const dns = egress.spec?.egress?.[3];
    expect(dns?.to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ]);
    expect(dns?.ports).toEqual([
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);
    expect(egress.spec?.egress).toHaveLength(4);
  });

  it('is positive-only: no ipBlock, so metadata and private ranges are denied by default-deny', () => {
    const { defaultDeny, egress } = renderRunNetworkPolicies(spec(), NS);
    const rendered = JSON.stringify([defaultDeny, egress]);
    expect(rendered).not.toContain('ipBlock');
    expect(rendered).not.toContain('169.254');
    expect(rendered).not.toContain('10.0.0.0');
  });

  it('never selects another run: every peer selector is a platform Service, never a sandbox pod', () => {
    const { egress } = renderRunNetworkPolicies(spec(), NS);
    for (const rule of egress.spec?.egress ?? []) {
      for (const peer of rule.to ?? []) {
        expect(JSON.stringify(peer)).not.toContain(KUBE_LABEL.runId);
        expect(JSON.stringify(peer)).not.toContain(KUBE_LABEL.sessionId);
      }
    }
  });

  it('renders the egress rules in declaration order, one per destination', () => {
    const { egress } = renderRunNetworkPolicies(
      spec({
        allowedDestinations: [{ kind: 'model-gateway', host: 'model-gateway', port: 13500 }],
      }),
      NS,
    );
    expect(egress.spec?.egress).toHaveLength(2);
    expect(egress.spec?.egress?.[0]?.ports).toEqual([{ protocol: 'TCP', port: 13500 }]);
  });

  it.each([
    [
      'an IPv4 literal for the run broker',
      { kind: 'run-broker' as const, host: '10.0.0.5', port: 7443 },
    ],
    [
      'a Service name with a suffix',
      { kind: 'egress-gateway' as const, host: 'egress-gateway.evil.example', port: 13128 },
    ],
    [
      'the wrong Service for the kind',
      { kind: 'model-gateway' as const, host: 'egress-gateway', port: 13500 },
    ],
  ])('refuses a destination that is not its in-cluster Service: %s', (_label, destination) => {
    expect(() =>
      renderRunNetworkPolicies(spec({ allowedDestinations: [destination] }), NS),
    ).toThrow(ValidationError);
  });
});
