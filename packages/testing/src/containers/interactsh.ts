import { Wait } from 'testcontainers';

import { TEST_IMAGES } from './images.js';
import {
  type ContainerOptions,
  containerCredential,
  resolveContainerOptions,
  startContainer,
} from './runtime.js';

/** The interactsh-server HTTP collaborator listener (the container's port 80). */
const HTTP_PORT = 80;
/** Zone the test server answers for. Never delegated: tests send `Host:` headers, no DNS is involved. */
const TEST_DOMAIN = 'oob.test.blackwing';

/** Options for {@link withInteractsh}. */
export type WithInteractshOptions = ContainerOptions;

/** A running interactsh-server (token-gated, in-memory state) on a random loopback port. */
export interface InteractshHandle {
  readonly service: 'interactsh';
  /** Base URL of the control and collaborator HTTP API, e.g. `http://127.0.0.1:49153`. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** Zone the server answers for (its `-domain`). */
  readonly domain: string;
  /** The `-token` the server requires on every API call. */
  readonly token: string;
  readonly reused: boolean;
  readonly containerId: string;
  logs(): string;
  /** Stops the container (unless reused). Idempotent. */
  stop(): Promise<void>;
}

/**
 * Starts the pinned interactsh-server (OOB-001, INFRA-010) with the same arguments as the dev compose
 * stack: token-authenticated, no ACME, in-memory interactions. Only HTTP is published; the DNS listener
 * is not needed to prove the register/poll/decrypt path.
 */
export async function withInteractsh(
  options: WithInteractshOptions = {},
): Promise<InteractshHandle> {
  const { image, reuse, startupTimeoutMs } = resolveContainerOptions(
    options,
    TEST_IMAGES.interactsh,
  );
  const token = containerCredential('interactsh:token', reuse);
  const started = await startContainer({
    service: 'interactsh',
    image,
    ports: [HTTP_PORT],
    command: [
      '-domain',
      TEST_DOMAIN,
      '-ip',
      '127.0.0.1',
      '-token',
      token,
      '-skip-acme',
      '-disable-update-check',
      '-eviction',
      '1',
    ],
    wait: Wait.forLogMessage(/\[HTTP\] Listening on TCP/),
    reuse,
    startupTimeoutMs,
  });
  const host = started.container.getHost();
  const port = started.container.getMappedPort(HTTP_PORT);
  return {
    service: 'interactsh',
    url: `http://${host}:${port}`,
    host,
    port,
    domain: TEST_DOMAIN,
    token,
    reused: started.reused,
    containerId: started.containerId,
    logs: () => started.logs(),
    stop: () => started.stop(),
  };
}
