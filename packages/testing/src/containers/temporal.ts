import { Wait } from 'testcontainers';

import { TEST_IMAGES } from './images.js';
import { type ContainerOptions, resolveContainerOptions, startContainer } from './runtime.js';

const TEMPORAL_PORT = 7233;

/** Options for {@link withTemporal}. */
export interface WithTemporalOptions extends ContainerOptions {
  /** Namespace created at start-up. Default `blackwing`. */
  readonly namespace?: string;
}

/** A single-node Temporal dev server (in-memory persistence) with one namespace registered. */
export interface TemporalHandle {
  readonly service: 'temporal';
  readonly host: string;
  readonly port: number;
  /** `host:port` for `TEMPORAL_ADDRESS`. */
  readonly address: string;
  readonly namespace: string;
  readonly reused: boolean;
  readonly containerId: string;
  logs(): string;
  stop(): Promise<void>;
}

/** Starts the Temporal CLI dev server (pinned by digest) with the given namespace. */
export async function withTemporal(options: WithTemporalOptions = {}): Promise<TemporalHandle> {
  const { image, reuse, startupTimeoutMs } = resolveContainerOptions(options, TEST_IMAGES.temporal);
  const namespace = options.namespace ?? 'blackwing';
  const started = await startContainer({
    service: 'temporal',
    image,
    ports: [TEMPORAL_PORT],
    command: [
      'server',
      'start-dev',
      '--ip',
      '0.0.0.0',
      '--headless',
      '--log-level',
      'warn',
      '--namespace',
      namespace,
    ],
    wait: Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(/Temporal server:|Server:/i)]),
    reuse,
    startupTimeoutMs,
  });
  const host = started.container.getHost();
  const port = started.container.getMappedPort(TEMPORAL_PORT);
  return {
    service: 'temporal',
    host,
    port,
    address: `${host}:${port}`,
    namespace,
    reused: started.reused,
    containerId: started.containerId,
    logs: () => started.logs(),
    stop: () => started.stop(),
  };
}
