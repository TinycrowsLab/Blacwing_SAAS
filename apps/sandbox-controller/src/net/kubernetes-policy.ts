import { ValidationError } from '@blackwing/errors';

import { MANAGED_BY } from '../drivers/docker-config.js';
import { KUBE_LABEL } from '../drivers/kubernetes-config.js';

import type { Destination, DestinationKind, RunNetworkSpec } from '@blackwing/contracts';
import type {
  V1LabelSelector,
  V1NetworkPolicy,
  V1NetworkPolicyEgressRule,
} from '@kubernetes/client-node';

/** Namespace of the platform services a sandbox may reach (`infra/k3s/network-policies`). */
const PLATFORM_NAMESPACE = 'bw-system';
const DNS_NAMESPACE = 'kube-system';
const NAMESPACE_NAME_LABEL = 'kubernetes.io/metadata.name';
const API_VERSION = 'networking.k8s.io/v1';

/**
 * The in-cluster Service each destination kind names, and the pods behind it. Policies select pods, not
 * Service IPs, so they follow a Service whose pods move. A destination whose host is not the Service name is
 * refused: an IP literal cannot be expressed as a pod selector.
 */
const DESTINATION_TARGETS: Record<
  DestinationKind,
  { readonly service: string; readonly pods: V1LabelSelector }
> = {
  'egress-gateway': {
    service: 'egress-gateway',
    pods: { matchLabels: { 'app.kubernetes.io/name': 'egress-gateway' } },
  },
  'model-gateway': {
    service: 'model-gateway',
    pods: { matchLabels: { 'app.kubernetes.io/name': 'model-gateway' } },
  },
  'run-broker': {
    service: 'run-broker',
    pods: {
      matchExpressions: [
        { key: 'app.kubernetes.io/name', operator: 'In', values: ['api', 'run-broker'] },
      ],
    },
  },
};

/** The run network name: the NetworkPolicy names are derived from it. */
export function runNetworkId(runId: string): string {
  return `bw-run-${runId}`;
}

export function runPolicyNames(runId: string): {
  readonly defaultDeny: string;
  readonly egress: string;
} {
  const base = runNetworkId(runId);
  return { defaultDeny: `${base}-default-deny`, egress: `${base}-egress` };
}

export interface RunNetworkPolicies {
  /** Selects every pod of the run and allows nothing: all ingress and all egress are denied. */
  readonly defaultDeny: V1NetworkPolicy;
  /** Allows egress to exactly the declared destinations and to kube-dns. Ingress stays denied. */
  readonly egress: V1NetworkPolicy;
}

function destinationRule(destination: Destination): V1NetworkPolicyEgressRule {
  const target = DESTINATION_TARGETS[destination.kind];
  if (destination.host !== target.service) {
    throw new ValidationError(
      `destination ${destination.kind} must name the in-cluster Service ${target.service}`,
    );
  }
  return {
    to: [
      {
        namespaceSelector: { matchLabels: { [NAMESPACE_NAME_LABEL]: PLATFORM_NAMESPACE } },
        podSelector: target.pods,
      },
    ],
    ports: [{ protocol: 'TCP', port: destination.port }],
  };
}

/**
 * Pure rendering of a run's two NetworkPolicies (no cluster contact). Positive-only: the egress policy holds
 * only the declared destinations and kube-dns on 53 (no `ipBlock`, so metadata endpoints and private ranges
 * stay denied by the default-deny policy) and every rule is scoped to this run's pods.
 */
export function renderRunNetworkPolicies(
  spec: RunNetworkSpec,
  namespace: string,
): RunNetworkPolicies {
  const names = runPolicyNames(spec.runId);
  const podSelector: V1LabelSelector = { matchLabels: { [KUBE_LABEL.runId]: spec.runId } };
  const labels = {
    [KUBE_LABEL.runId]: spec.runId,
    [KUBE_LABEL.tenantId]: spec.tenantId,
    [KUBE_LABEL.managedBy]: MANAGED_BY,
  };
  const dnsRule: V1NetworkPolicyEgressRule = {
    to: [
      {
        namespaceSelector: { matchLabels: { [NAMESPACE_NAME_LABEL]: DNS_NAMESPACE } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  return {
    defaultDeny: {
      apiVersion: API_VERSION,
      kind: 'NetworkPolicy',
      metadata: { name: names.defaultDeny, namespace, labels: { ...labels } },
      spec: { podSelector, policyTypes: ['Ingress', 'Egress'] },
    },
    egress: {
      apiVersion: API_VERSION,
      kind: 'NetworkPolicy',
      metadata: { name: names.egress, namespace, labels: { ...labels } },
      spec: {
        podSelector,
        policyTypes: ['Egress'],
        egress: [
          ...spec.allowedDestinations.map((destination) => destinationRule(destination)),
          dnsRule,
        ],
      },
    },
  };
}
