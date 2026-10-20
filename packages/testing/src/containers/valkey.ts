import { Redis } from 'ioredis';
import { Wait } from 'testcontainers';

import { TEST_IMAGES } from './images.js';
import {
  type ContainerOptions,
  containerCredential,
  resolveContainerOptions,
  startContainer,
  uniqueSuffix,
} from './runtime.js';

const VALKEY_PORT = 6379;
const SCAN_BATCH = 500;

/** Options for {@link withValkey}. */
export type WithValkeyOptions = ContainerOptions;

/** A Valkey 8 server plus a client confined to this call's key prefix. */
export interface ValkeyHandle {
  readonly service: 'valkey';
  readonly host: string;
  readonly port: number;
  /** Password the server requires (`requirepass`). */
  readonly password: string;
  /**
   * Prefix unique to this call (`t:<random>:`). `client` applies it to every key automatically,
   * mirroring the per-tenant key prefixes of §8.6.
   */
  readonly keyPrefix: string;
  /** ioredis client (the client BullMQ uses) with `keyPrefix` applied. */
  readonly client: Redis;
  readonly reused: boolean;
  /** Docker id of the container (for debugging and leak checks). */
  readonly containerId: string;
  /** A new client with its own options (e.g. another prefix); closed by `stop`. */
  createClient(options?: { readonly keyPrefix?: string }): Redis;
  logs(): string;
  /** Deletes this call's keys, closes clients and stops the container (unless reused). Idempotent. */
  stop(): Promise<void>;
}

/** Starts Valkey 8 (pinned by digest) with a password and no persistence. */
export async function withValkey(options: WithValkeyOptions = {}): Promise<ValkeyHandle> {
  const { image, reuse, startupTimeoutMs } = resolveContainerOptions(options, TEST_IMAGES.valkey);
  const password = containerCredential('valkey:default', reuse);
  const started = await startContainer({
    service: 'valkey',
    image,
    ports: [VALKEY_PORT],
    command: ['valkey-server', '--requirepass', password, '--save', '', '--appendonly', 'no'],
    wait: Wait.forAll([
      Wait.forListeningPorts(),
      Wait.forLogMessage(/Ready to accept connections/),
    ]),
    reuse,
    startupTimeoutMs,
  });
  const host = started.container.getHost();
  const port = started.container.getMappedPort(VALKEY_PORT);
  const keyPrefix = `t:${uniqueSuffix()}:`;
  const clients: Redis[] = [];
  const createClient = (clientOptions: { readonly keyPrefix?: string } = {}): Redis => {
    const client = new Redis({
      host,
      port,
      password,
      keyPrefix: clientOptions.keyPrefix ?? '',
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
    client.on('error', () => undefined);
    clients.push(client);
    return client;
  };
  const client = createClient({ keyPrefix });
  let stopped = false;

  return {
    service: 'valkey',
    host,
    port,
    password,
    keyPrefix,
    client,
    reused: started.reused,
    containerId: started.containerId,
    createClient,
    logs: () => started.logs(),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        if (started.reused) {
          // Reused servers outlive this call: remove exactly this call's keys.
          const admin = createClient();
          let cursor = '0';
          do {
            const [next, keys] = await admin.scan(
              cursor,
              'MATCH',
              `${keyPrefix}*`,
              'COUNT',
              SCAN_BATCH,
            );
            if (keys.length > 0) await admin.del(...keys);
            cursor = next;
          } while (cursor !== '0');
        }
      } finally {
        await Promise.all(
          clients.map((c) =>
            c.quit().catch(() => {
              c.disconnect();
            }),
          ),
        );
        await started.stop();
      }
    },
  };
}
