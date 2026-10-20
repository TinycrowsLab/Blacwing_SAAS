import { connect } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ValkeyHandle, withValkey } from './valkey.js';
import { surfaceContainerLogsOnFailure } from '../vitest/index.js';

let valkey: ValkeyHandle | undefined;
const handle = (): ValkeyHandle => {
  if (valkey === undefined) throw new Error('withValkey did not start');
  return valkey;
};

beforeAll(async () => {
  valkey = await withValkey();
});
afterAll(async () => {
  await valkey?.stop();
});
surfaceContainerLogsOnFailure(() => [valkey]);

describe('withValkey', () => {
  it('serves reads and writes through the prefixed client', async () => {
    await handle().client.set('greeting', 'hello');
    expect(await handle().client.get('greeting')).toBe('hello');
    const raw = handle().createClient();
    expect(await raw.get(`${handle().keyPrefix}greeting`)).toBe('hello');
  });

  it('requires the password', async () => {
    // Speak RESP directly: an unauthenticated PING must be refused.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: handle().host, port: handle().port }, () =>
        socket.write('PING\r\n'),
      );
      socket.setEncoding('utf8');
      socket.once('data', (data: string) => {
        socket.destroy();
        resolve(data);
      });
      socket.once('error', reject);
    });
    expect(reply).toMatch(/^-NOAUTH/);
  });

  it('keeps clients with different prefixes apart (per-tenant key prefixes, §8.6)', async () => {
    const tenantA = handle().createClient({ keyPrefix: `${handle().keyPrefix}ten-a:` });
    const tenantB = handle().createClient({ keyPrefix: `${handle().keyPrefix}ten-b:` });
    await tenantA.set('session', 'a');
    expect(await tenantB.get('session')).toBeNull();
    expect(await tenantA.get('session')).toBe('a');
  });

  it('has a key prefix unique to the call', () => {
    expect(handle().keyPrefix).toMatch(/^t:[0-9a-f]{12}:$/);
  });
});
