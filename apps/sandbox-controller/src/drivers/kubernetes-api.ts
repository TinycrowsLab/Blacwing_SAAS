import { PassThrough } from 'node:stream';

import {
  CoreV1Api,
  KubeConfig,
  Log,
  NodeV1Api,
  VersionApi,
  type V1Pod,
  type V1RuntimeClass,
} from '@kubernetes/client-node';

const HTTP_NOT_FOUND = 404;

export interface KubeLogRequest {
  readonly follow: boolean;
  readonly tailLines?: number | undefined;
  /** RFC 3339 instant; only lines at or after it. */
  readonly sinceTime?: string | undefined;
}

/**
 * The narrow slice of the Kubernetes API the driver uses. A missing object resolves `undefined` (read)
 * or resolves (delete), so "already gone" is never an error. Every other failure throws with a numeric
 * HTTP `code` (client-node `ApiException`) or a Node network `code`.
 */
export interface KubeApi {
  version(): Promise<void>;
  /** The RuntimeClass by name, or `undefined` when the cluster does not define it. */
  readRuntimeClass(name: string): Promise<V1RuntimeClass | undefined>;
  createPod(namespace: string, pod: V1Pod): Promise<V1Pod>;
  readPod(namespace: string, name: string): Promise<V1Pod | undefined>;
  /** Full-object replace; the API server enforces `resourceVersion` (optimistic concurrency). */
  replacePod(namespace: string, pod: V1Pod): Promise<V1Pod>;
  listPods(namespace: string, labelSelector: string): Promise<V1Pod[]>;
  /** Deletes with an explicit grace period (0 = immediate kill). */
  deletePod(namespace: string, name: string, graceSeconds: number): Promise<void>;
  /** Timestamped container log bytes, streamed until the container ends (or forever with `follow`). */
  streamLogs(
    namespace: string,
    name: string,
    container: string,
    request: KubeLogRequest,
  ): Promise<AsyncIterable<Uint8Array>>;
}

/**
 * Real client over `@kubernetes/client-node`. `loadFromDefault` uses the in-cluster service account when
 * the controller runs in a Pod and the kubeconfig (`KUBECONFIG`, `~/.kube/config`) otherwise. Built lazily
 * by the driver, never at module load.
 */
export function createKubeApi(): KubeApi {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const core = kubeConfig.makeApiClient(CoreV1Api);
  const nodes = kubeConfig.makeApiClient(NodeV1Api);
  const versions = kubeConfig.makeApiClient(VersionApi);
  const logs = new Log(kubeConfig);

  return {
    async version() {
      await versions.getCode();
    },
    async readRuntimeClass(name) {
      try {
        return await nodes.readRuntimeClass({ name });
      } catch (error) {
        if (statusCodeOf(error) === HTTP_NOT_FOUND) return undefined;
        throw error;
      }
    },
    createPod(namespace, pod) {
      return core.createNamespacedPod({ namespace, body: pod });
    },
    async readPod(namespace, name) {
      try {
        return await core.readNamespacedPod({ name, namespace });
      } catch (error) {
        if (statusCodeOf(error) === HTTP_NOT_FOUND) return undefined;
        throw error;
      }
    },
    replacePod(namespace, pod) {
      return core.replaceNamespacedPod({ name: pod.metadata?.name ?? '', namespace, body: pod });
    },
    async listPods(namespace, labelSelector) {
      const list = await core.listNamespacedPod({ namespace, labelSelector });
      return list.items;
    },
    async deletePod(namespace, name, graceSeconds) {
      try {
        await core.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: graceSeconds });
      } catch (error) {
        if (statusCodeOf(error) !== HTTP_NOT_FOUND) throw error;
      }
    },
    async streamLogs(namespace, name, container, request) {
      const stream = new PassThrough();
      await logs.log(namespace, name, container, stream, {
        follow: request.follow,
        timestamps: true,
        ...(request.tailLines === undefined ? {} : { tailLines: request.tailLines }),
        ...(request.sinceTime === undefined ? {} : { sinceTime: request.sinceTime }),
      });
      return stream;
    },
  };
}

/** HTTP status of a client-node `ApiException` (or any error exposing a numeric `code`). */
export function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}
