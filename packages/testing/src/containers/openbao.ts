import { Wait } from 'testcontainers';

import { TEST_IMAGES } from './images.js';
import {
  type ContainerOptions,
  containerCredential,
  resolveContainerOptions,
  startContainer,
} from './runtime.js';

const OPENBAO_PORT = 8200;

/** Options for {@link withOpenBao}. */
export type WithOpenBaoOptions = ContainerOptions;

/** An in-memory OpenBao dev server (unsealed, root token known to the test only). */
export interface OpenBaoHandle {
  readonly service: 'openbao';
  /** `http://host:port`. */
  readonly addr: string;
  readonly rootToken: string;
  readonly reused: boolean;
  readonly containerId: string;
  logs(): string;
  stop(): Promise<void>;
}

/** Starts `bao server -dev` (pinned by digest). Dev mode is ephemeral: nothing persists. */
export async function withOpenBao(options: WithOpenBaoOptions = {}): Promise<OpenBaoHandle> {
  const { image, reuse, startupTimeoutMs } = resolveContainerOptions(options, TEST_IMAGES.openbao);
  const rootToken = containerCredential('openbao:root', reuse);
  const started = await startContainer({
    service: 'openbao',
    image,
    ports: [OPENBAO_PORT],
    env: { BAO_DEV_ROOT_TOKEN_ID: rootToken, BAO_DEV_LISTEN_ADDRESS: '0.0.0.0:8200' },
    command: ['server', '-dev'],
    wait: Wait.forAll([
      Wait.forListeningPorts(),
      Wait.forLogMessage(
        /Vault server started|OpenBao server started|core: post-unseal setup complete/,
      ),
    ]),
    reuse,
    startupTimeoutMs,
  });
  return {
    service: 'openbao',
    addr: `http://${started.container.getHost()}:${started.container.getMappedPort(OPENBAO_PORT)}`,
    rootToken,
    reused: started.reused,
    containerId: started.containerId,
    logs: () => started.logs(),
    stop: () => started.stop(),
  };
}
