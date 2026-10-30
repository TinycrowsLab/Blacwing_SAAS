import { Readable } from 'node:stream';

import { RUNTIME_HANDLER, podName } from './kubernetes-config.js';

import type { KubeApi, KubeLogRequest } from './kubernetes-api.js';
import type { V1NetworkPolicy, V1Pod, V1RuntimeClass } from '@kubernetes/client-node';

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/**
 * In-memory `KubeApi` for driver and provisioner tests: pods, RuntimeClasses and NetworkPolicies behave like
 * the API server (409 on a duplicate create, optimistic `resourceVersion` on replace, 404 tolerated on delete).
 * Test-only; nothing here is imported by the product code.
 */
/** An error shaped like client-node's ApiException (numeric `code`). */
export const httpError = (code: number): Error =>
  Object.assign(new Error(`HTTP ${String(code)}`), { code });
export const netError = (code: string): Error => Object.assign(new Error(code), { code });

/** Stored NetworkPolicies by name (SANDBOX-005). */
export class FakeKube implements KubeApi {
  /** The clock stamped on created objects; tests inject a fixed instant. */
  readonly clock: Date = new Date('2026-10-20T10:00:00.000Z');
  readonly netpols = new Map<string, V1NetworkPolicy>();
  readonly pods = new Map<string, V1Pod>();
  readonly runtimeClasses = new Map<string, V1RuntimeClass>([
    ['gvisor', { metadata: { name: 'gvisor' }, handler: RUNTIME_HANDLER }],
  ]);
  readonly calls: string[] = [];
  readonly graceSeconds: number[] = [];
  readonly logRequests: KubeLogRequest[] = [];
  logChunks: Uint8Array[] = [];
  /** Errors thrown by the next calls of an operation, in order. */
  readonly failures: { op: string; error: Error }[] = [];
  /** Operations that never settle (to exercise the context timeout). */
  readonly hang = new Set<string>();
  private uid = 0;

  private enter(op: string): Promise<void> | undefined {
    this.calls.push(op);
    const failure = this.failures.find((f) => f.op === op);
    if (failure !== undefined) {
      this.failures.splice(this.failures.indexOf(failure), 1);
      return Promise.reject(failure.error);
    }
    if (this.hang.has(op)) return new Promise<void>(() => undefined);
    return undefined;
  }

  async version(): Promise<void> {
    const failed = this.enter('version');
    if (failed) await failed;
  }

  async readRuntimeClass(name: string): Promise<V1RuntimeClass | undefined> {
    const failed = this.enter('readRuntimeClass');
    if (failed) await failed;
    return this.runtimeClasses.get(name);
  }

  async createPod(namespace: string, pod: V1Pod): Promise<V1Pod> {
    const failed = this.enter('createPod');
    if (failed) await failed;
    const name = pod.metadata?.name ?? '';
    if (this.pods.has(name)) throw httpError(HTTP_CONFLICT);
    this.uid += 1;
    const stored = structuredClone(pod);
    stored.metadata ??= {};
    stored.metadata.namespace = namespace;
    stored.metadata.uid = `uid-${String(this.uid)}`;
    stored.metadata.creationTimestamp = this.clock;
    stored.status = { phase: 'Pending' };
    this.pods.set(name, stored);
    return stored;
  }

  async readPod(_namespace: string, name: string): Promise<V1Pod | undefined> {
    const failed = this.enter('readPod');
    if (failed) await failed;
    return this.pods.get(name);
  }

  async replacePod(_namespace: string, pod: V1Pod): Promise<V1Pod> {
    const failed = this.enter('replacePod');
    if (failed) await failed;
    const name = pod.metadata?.name ?? '';
    this.pods.set(name, pod);
    return pod;
  }

  async listPods(_namespace: string, labelSelector: string): Promise<V1Pod[]> {
    const failed = this.enter('listPods');
    if (failed) await failed;
    const wanted = labelSelector.split(',').map((term) => term.split('='));
    return [...this.pods.values()].filter((pod) =>
      wanted.every(([key, value]) => pod.metadata?.labels?.[key ?? ''] === value),
    );
  }

  async deletePod(_namespace: string, name: string, graceSeconds: number): Promise<void> {
    const failed = this.enter('deletePod');
    if (failed) await failed;
    this.graceSeconds.push(graceSeconds);
    this.pods.delete(name);
  }

  async streamLogs(
    _namespace: string,
    _name: string,
    _container: string,
    request: KubeLogRequest,
  ): Promise<AsyncIterable<Uint8Array>> {
    const failed = this.enter('streamLogs');
    if (failed) await failed;
    this.logRequests.push(request);
    return Readable.from(this.logChunks);
  }

  async createNetworkPolicy(namespace: string, policy: V1NetworkPolicy): Promise<V1NetworkPolicy> {
    const failed = this.enter('createNetworkPolicy');
    if (failed) await failed;
    const name = policy.metadata?.name ?? '';
    if (this.netpols.has(name)) throw httpError(HTTP_CONFLICT);
    this.uid += 1;
    const stored = structuredClone(policy);
    stored.metadata ??= {};
    Object.assign(stored.metadata, {
      namespace,
      uid: `np-uid-${String(this.uid)}`,
      resourceVersion: String(this.uid),
      creationTimestamp: this.clock,
    });
    this.netpols.set(name, stored);
    return stored;
  }

  async readNetworkPolicy(_namespace: string, name: string): Promise<V1NetworkPolicy | undefined> {
    const failed = this.enter('readNetworkPolicy');
    if (failed) await failed;
    return this.netpols.get(name);
  }

  /** Optimistic concurrency: a stale `resourceVersion` is a 409, like the API server. */
  async replaceNetworkPolicy(namespace: string, policy: V1NetworkPolicy): Promise<V1NetworkPolicy> {
    const failed = this.enter('replaceNetworkPolicy');
    if (failed) await failed;
    const name = policy.metadata?.name ?? '';
    const current = this.netpols.get(name);
    if (current === undefined) throw httpError(HTTP_NOT_FOUND);
    if (policy.metadata?.resourceVersion !== current.metadata?.resourceVersion)
      throw httpError(HTTP_CONFLICT);
    this.uid += 1;
    const stored = structuredClone(policy);
    stored.metadata ??= {};
    Object.assign(stored.metadata, {
      namespace,
      resourceVersion: String(this.uid),
      uid: current.metadata?.uid ?? `np-uid-${String(this.uid)}`,
      creationTimestamp: current.metadata?.creationTimestamp ?? this.clock,
    });
    this.netpols.set(name, stored);
    return stored;
  }

  async deleteNetworkPolicy(_namespace: string, name: string): Promise<void> {
    const failed = this.enter('deleteNetworkPolicy');
    if (failed) await failed;
    this.netpols.delete(name);
  }

  /** Moves a stored Pod to a status the cluster would report. */
  setStatus(sandboxId: string, status: NonNullable<V1Pod['status']>, deleting = false): void {
    const pod = this.pods.get(podName(sandboxId));
    if (pod === undefined) throw new Error('no such pod');
    pod.status = status;
    if (deleting) {
      pod.metadata ??= {};
      pod.metadata.deletionTimestamp = this.clock;
    }
  }
}
