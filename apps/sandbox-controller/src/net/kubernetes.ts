import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  runNetworkSpecSchema,
  type RunNetworkHandle,
  type RunNetworkSpec,
  uuidV7Schema,
} from '@blackwing/contracts';
import { AppError, ConflictError, ValidationError } from '@blackwing/errors';

import { KUBE_LABEL } from '../drivers/kubernetes-config.js';
import { SbxNetpolUnsupportedError, SbxNetworkUnavailableError } from '../errors.js';
import { parseInput as parse } from '../validate.js';
import { renderRunNetworkPolicies, runNetworkId, runPolicyNames } from './kubernetes-policy.js';

import type { NetpolEnforcer } from '../config.js';
import type { NetworkProvisioner, RunNetworkEvent } from './provisioner.js';
import type { KubeApi } from '../drivers/kubernetes-api.js';
import type { V1NetworkPolicy } from '@kubernetes/client-node';

const TRACER_NAME = '@blackwing/sandbox-controller';

/** The one logging call the provisioner makes (structured, no values). */
export interface NetLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** `sbx_netpol_apply_total{result}` outcomes. */
export type NetpolApplyResult = 'applied' | 'failed' | 'unsupported';

/**
 * Runs one Kubernetes API call through the driver's timeout and retry wrapper. Every network call goes
 * through it, so transient API failures retry and anything else surfaces as SBX_DRIVER_UNAVAILABLE.
 */
export type KubeCall = <T>(fn: (api: KubeApi) => Promise<T>) => Promise<T>;

export interface KubernetesNetworkOptions {
  /** Namespace of the sandbox Pods and of their NetworkPolicies (`SBX_NAMESPACE`). */
  readonly namespace: string;
  readonly now: () => Date;
  /** The CNI declared to enforce NetworkPolicy (`SBX_NETPOL_ENFORCER`). Undefined refuses every network. */
  readonly enforcer: NetpolEnforcer | undefined;
  /** Receives `run_network.created` and `run_network.destroyed` (audit). */
  readonly onEvent?: ((event: RunNetworkEvent) => void) | undefined;
  /** `sbx_netpol_apply_total{result}` hook. */
  readonly onApply?: ((result: NetpolApplyResult) => void) | undefined;
  readonly logger?: NetLogger | undefined;
  readonly tracer?: Tracer | undefined;
}

/**
 * Run-network provisioner on Kubernetes (SANDBOX-005). Each run gets two NetworkPolicies in the sandbox
 * namespace: a default-deny for every pod of the run, and an egress allow to exactly the declared
 * destinations plus kube-dns. The policies select pods by the run label, so no policy reaches another run's
 * pods, and none carries an `ipBlock`, so the metadata endpoint and private ranges stay denied.
 *
 * Fail closed: without a declared enforcer nothing is applied; the default-deny is applied before the allow,
 * so a partial apply leaves the run with no egress and `assertNetwork` (checked by sandbox creation) refuses
 * to start a sandbox on it.
 */
export class KubernetesNetworkProvisioner implements NetworkProvisioner {
  private readonly tracer: Tracer;

  constructor(
    private readonly call: KubeCall,
    private readonly options: KubernetesNetworkOptions,
  ) {
    this.tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  }

  async ensureNetwork(input: RunNetworkSpec): Promise<RunNetworkHandle> {
    const spec = parse(runNetworkSpecSchema, input, 'run network spec');
    if (spec.driver !== 'kubernetes') {
      throw new ValidationError(`run network targets driver ${spec.driver}, not kubernetes`);
    }
    if (this.options.enforcer === undefined) {
      this.options.onApply?.('unsupported');
      throw new SbxNetpolUnsupportedError(
        'no NetworkPolicy enforcer is declared (SBX_NETPOL_ENFORCER); refusing to provision a run network',
      );
    }
    const span = this.tracer.startSpan('netpol.ensure', {
      attributes: { 'bw.run_id': spec.runId, 'bw.netpol.enforcer': this.options.enforcer },
    });
    try {
      const policies = renderRunNetworkPolicies(spec, this.options.namespace);
      const outcome = await this.call(async (api) => {
        const names = runPolicyNames(spec.runId);
        const before = await api.readNetworkPolicy(this.options.namespace, names.egress);
        const deny = await this.apply(api, policies.defaultDeny, spec.tenantId);
        const egress = await this.apply(api, policies.egress, spec.tenantId);
        return { created: before === undefined, deny, egress };
      });
      this.options.onApply?.('applied');
      if (outcome.created) {
        this.emit('run_network.created', spec.runId, spec.tenantId);
      }
      return {
        runId: spec.runId,
        tenantId: spec.tenantId,
        networkId: runNetworkId(spec.runId),
        driver: 'kubernetes',
        nativeId: outcome.egress.metadata?.uid ?? outcome.egress.metadata?.name ?? '',
        createdAt: new Date(
          outcome.egress.metadata?.creationTimestamp ?? this.options.now(),
        ).toISOString(),
      };
    } catch (error) {
      this.options.onApply?.('failed');
      span.setStatus({ code: SpanStatusCode.ERROR });
      this.options.logger?.warn(
        { component: 'netprovisioner', run_id: spec.runId, reason: reasonCode(error) },
        'sbx.netpol.apply_failed',
      );
      throw networkFailure(error);
    } finally {
      span.end();
    }
  }

  async removeNetwork(runIdInput: string): Promise<void> {
    const runId = parse(uuidV7Schema, runIdInput, 'run id');
    const names = runPolicyNames(runId);
    const removed = await this.call(async (api) => {
      const pods = await api.listPods(this.options.namespace, `${KUBE_LABEL.runId}=${runId}`);
      if (pods.length > 0) throw new ConflictError('run network still has live sandboxes');
      const deny = await api.readNetworkPolicy(this.options.namespace, names.defaultDeny);
      const egress = await api.readNetworkPolicy(this.options.namespace, names.egress);
      // The allow goes first, so nothing is reachable from the run while its default-deny is torn down.
      await api.deleteNetworkPolicy(this.options.namespace, names.egress);
      await api.deleteNetworkPolicy(this.options.namespace, names.defaultDeny);
      return deny ?? egress;
    });
    if (removed !== undefined) {
      this.emit('run_network.destroyed', runId, tenantOf(removed) ?? '');
    }
  }

  async assertNetwork(runId: string, tenantId: string): Promise<void> {
    if (this.options.enforcer === undefined) {
      throw new SbxNetpolUnsupportedError(
        'no NetworkPolicy enforcer is declared (SBX_NETPOL_ENFORCER)',
      );
    }
    const names = runPolicyNames(runId);
    const [deny, egress] = await this.call(async (api) => [
      await api.readNetworkPolicy(this.options.namespace, names.defaultDeny),
      await api.readNetworkPolicy(this.options.namespace, names.egress),
    ]);
    if (deny === undefined || egress === undefined) {
      throw new SbxNetworkUnavailableError(
        'run network is not fully provisioned; sandbox creation is blocked',
      );
    }
    if (tenantOf(deny) !== tenantId || tenantOf(egress) !== tenantId) {
      throw new ConflictError('run network belongs to another tenant');
    }
  }

  /**
   * Creates the policy, or replaces the existing one of the same name (a reconcile). Refuses a policy that
   * belongs to another tenant, and replaces with the stored `resourceVersion` so a concurrent edit conflicts.
   */
  private async apply(
    api: KubeApi,
    policy: V1NetworkPolicy,
    tenantId: string,
  ): Promise<V1NetworkPolicy> {
    const name = policy.metadata?.name ?? '';
    const existing = await api.readNetworkPolicy(this.options.namespace, name);
    if (existing === undefined) return api.createNetworkPolicy(this.options.namespace, policy);
    if (tenantOf(existing) !== tenantId) {
      throw new ConflictError('run network belongs to another tenant');
    }
    const next = structuredClone(policy);
    next.metadata ??= {};
    const resourceVersion = existing.metadata?.resourceVersion;
    if (resourceVersion !== undefined) next.metadata.resourceVersion = resourceVersion;
    return api.replaceNetworkPolicy(this.options.namespace, next);
  }

  private emit(type: RunNetworkEvent['type'], runId: string, tenantId: string): void {
    this.options.onEvent?.({ type, runId, tenantId, at: this.options.now().toISOString() });
  }
}

function tenantOf(policy: V1NetworkPolicy): string | undefined {
  return policy.metadata?.labels?.[KUBE_LABEL.tenantId];
}

/** Scope and validation refusals pass through; any other failure becomes SBX_NETWORK_UNAVAILABLE. */
function networkFailure(error: unknown): unknown {
  if (error instanceof ValidationError || error instanceof ConflictError) return error;
  if (error instanceof SbxNetpolUnsupportedError) return error;
  return new SbxNetworkUnavailableError(
    'run network policies could not be applied; sandbox creation is blocked',
    error instanceof Error ? { cause: error } : {},
  );
}

/** A bounded, value-free failure code for logs (never the API response body). */
function reasonCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'unexpected';
}
