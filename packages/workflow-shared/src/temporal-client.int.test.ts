import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseTemporalConfig } from '@blackwing/config';
import { AppError } from '@blackwing/errors';
import { type TemporalHandle, withTemporal } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { closeTemporal, getTemporalClient, getTemporalConnection } from './temporal-client.js';

let temporal: TemporalHandle | undefined;
const handle = (): TemporalHandle => {
  if (temporal === undefined) throw new Error('withTemporal did not start');
  return temporal;
};

beforeAll(async () => {
  temporal = await withTemporal({ namespace: 'blackwing' });
});
afterEach(async () => {
  await closeTemporal();
});
afterAll(async () => {
  await temporal?.stop();
});
surfaceContainerLogsOnFailure(() => [temporal]);

const config = (namespace: string) =>
  parseTemporalConfig({
    NODE_ENV: 'test',
    TEMPORAL_ADDRESS: handle().address,
    TEMPORAL_NAMESPACE: namespace,
  });

describe('getTemporalClient against a real Temporal server', () => {
  it('connects and describes the blackwing namespace', async () => {
    const client = await getTemporalClient({ config: config('blackwing') });
    expect(client.options.namespace).toBe('blackwing');
    const described = await client.workflowService.describeNamespace({ namespace: 'blackwing' });
    expect(described.namespaceInfo?.name).toBe('blackwing');
  });

  it('reuses one connection across 100 calls', async () => {
    const options = { config: config('blackwing') };
    const connections = await Promise.all(
      Array.from({ length: 100 }, () => getTemporalConnection(options)),
    );
    expect(new Set(connections).size).toBe(1);
    expect(await getTemporalClient(options)).toBe(await getTemporalClient(options));
  });

  it('surfaces TEMPORAL_NAMESPACE_NOT_FOUND for a missing namespace', async () => {
    const error = await getTemporalConnection({ config: config('no-such-namespace') }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('TEMPORAL_NAMESPACE_NOT_FOUND');
  });
});
