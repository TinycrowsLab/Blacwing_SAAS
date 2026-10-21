import { Readable } from 'node:stream';

import Docker from 'dockerode';

import type { DockerContainerConfig } from './docker-config.js';

/** What `DockerDriver` needs from `inspect`. */
export interface DockerInspect {
  readonly Id: string;
  readonly Created: string;
  readonly Config: { readonly Labels?: Record<string, string> | null };
  readonly State: {
    readonly Status: string;
    readonly Running?: boolean;
    readonly OOMKilled?: boolean;
    readonly ExitCode?: number;
    readonly Error?: string;
    readonly Health?: { readonly Status: string } | null;
  };
  readonly NetworkSettings?: {
    readonly Networks?: Record<
      string,
      { readonly IPAddress?: string; readonly GlobalIPv6Address?: string }
    >;
  };
}

const HTTP_NOT_FOUND = 404;

export interface DockerLogRequest {
  readonly follow: boolean;
  readonly tail?: number | undefined;
  /** Unix seconds. */
  readonly since?: number | undefined;
}

/**
 * The narrow slice of the Docker Engine API the driver uses. Errors thrown carry a numeric
 * `statusCode` (HTTP) or a Node `code` (ECONNREFUSED, ENOENT, ...), like dockerode's.
 */
export interface DockerApi {
  ping(): Promise<void>;
  /** Names of the runtimes the daemon has registered. */
  runtimes(): Promise<readonly string[]>;
  /** Container ids (running or not) carrying every `key=value` label. */
  findByLabels(labels: readonly string[]): Promise<readonly string[]>;
  createContainer(config: DockerContainerConfig): Promise<string>;
  inspect(id: string): Promise<DockerInspect>;
  start(id: string): Promise<void>;
  stop(id: string, graceSeconds: number): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Multiplexed (stdout/stderr framed) log bytes with timestamps. */
  logs(id: string, request: DockerLogRequest): Promise<AsyncIterable<Uint8Array>>;
  imageExists(reference: string): Promise<boolean>;
  pullImage(reference: string): Promise<void>;
  close(): void;
}

/** Real Engine client over dockerode. Built lazily by the driver, never at module load. */
export function createDockerodeApi(socketPath: string): DockerApi {
  const docker = new Docker({ socketPath });
  return {
    async ping() {
      await docker.ping();
    },
    async runtimes() {
      const info = (await docker.info()) as { Runtimes?: Record<string, unknown> };
      return Object.keys(info.Runtimes ?? {});
    },
    async findByLabels(labels) {
      const list = await docker.listContainers({ all: true, filters: { label: [...labels] } });
      return list.map((c) => c.Id);
    },
    async createContainer(config) {
      const container = await docker.createContainer({ ...config });
      return container.id;
    },
    async inspect(id) {
      return (await docker.getContainer(id).inspect()) as unknown as DockerInspect;
    },
    async start(id) {
      await docker.getContainer(id).start();
    },
    async stop(id, graceSeconds) {
      await docker.getContainer(id).stop({ t: graceSeconds });
    },
    async kill(id) {
      await docker.getContainer(id).kill();
    },
    async remove(id) {
      await docker.getContainer(id).remove({ force: true, v: true });
    },
    async logs(id, request) {
      const stream: unknown = await docker.getContainer(id).logs({
        stdout: true,
        stderr: true,
        timestamps: true,
        follow: request.follow,
        ...(request.tail !== undefined ? { tail: request.tail } : {}),
        ...(request.since !== undefined ? { since: request.since } : {}),
      } as Docker.ContainerLogsOptions & { follow: true });
      if (stream instanceof Uint8Array) return Readable.from([stream]);
      return stream as AsyncIterable<Uint8Array>;
    },
    async imageExists(reference) {
      try {
        await docker.getImage(reference).inspect();
        return true;
      } catch (error) {
        if (statusOf(error) === HTTP_NOT_FOUND) return false;
        throw error;
      }
    },
    async pullImage(reference) {
      const stream = await docker.pull(reference);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error: Error | null) => {
          if (error === null) resolve();
          else reject(error);
        });
      });
    },
    close() {
      // dockerode keeps no persistent connection to release.
    },
  };
}

export function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const code = error.statusCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}
