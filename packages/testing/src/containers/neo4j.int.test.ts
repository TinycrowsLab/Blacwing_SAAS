// withNeo4j smoke test with the tenantId guard (§8.6: Neo4j isolation by a mandatory tenantId).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { crossTenantDenied } from '../cross-tenant.js';
import { createFactories } from '../factories.js';
import { type Neo4jHandle, withNeo4j } from './neo4j.js';
import { TenantContextError } from './tenant.js';
import { surfaceContainerLogsOnFailure } from '../vitest/index.js';

let graph: Neo4jHandle | undefined;
const handle = (): Neo4jHandle => {
  if (graph === undefined) throw new Error('withNeo4j did not start');
  return graph;
};
const factories = createFactories({ seed: 7 });
const tenantA = factories.makeTenant();
const tenantB = factories.makeTenant();
const assetA = factories.makeAsset({ tenantId: tenantA.id });

beforeAll(async () => {
  graph = await withNeo4j();
  await handle().runForTenant(
    tenantA.id,
    'CREATE (:Asset {id: $id, tenantId: $tenantId, host: $host})',
    {
      id: assetA.id,
      host: 'a.example.test',
    },
  );
  await handle().runForTenant(
    tenantB.id,
    "CREATE (:Asset {id: $id, tenantId: $tenantId, host: 'b.example.test'})",
    {
      id: factories.newId(),
    },
  );
});
afterAll(async () => {
  await graph?.stop();
});
surfaceContainerLogsOnFailure(() => [graph]);

describe('withNeo4j', () => {
  it('runs Neo4j 5 Community', async () => {
    const { records } = await handle().driver.executeQuery(
      'CALL dbms.components() YIELD name, versions, edition RETURN name, versions[0] AS version, edition',
    );
    expect(records[0]?.get('edition')).toBe('community');
    expect(String(records[0]?.get('version'))).toMatch(/^5\./);
  });

  it("tenant B cannot read tenant A's node through the guard, and tenant A can", async () => {
    const result = await crossTenantDenied(
      (tenantId) =>
        handle().runForTenant<{ host: string }>(
          tenantId,
          'MATCH (a:Asset {id: $id}) WHERE a.tenantId = $tenantId RETURN a.host AS host',
          {
            id: assetA.id,
          },
        ),
      { ownerTenantId: tenantA.id, otherTenantId: tenantB.id, subject: 'Asset node' },
    );
    expect(result.ownerResult.records.map((r) => r.get('host'))).toEqual(['a.example.test']);
  });

  it('rejects a query that does not filter on $tenantId (fail closed)', async () => {
    await expect(
      handle().runForTenant(tenantA.id, 'MATCH (a:Asset) RETURN a'),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it('rejects a caller-supplied tenantId parameter and a malformed tenant id', async () => {
    await expect(
      handle().runForTenant(tenantA.id, 'MATCH (a:Asset) WHERE a.tenantId = $tenantId RETURN a', {
        tenantId: tenantB.id,
      }),
    ).rejects.toBeInstanceOf(TenantContextError);
    await expect(
      handle().runForTenant('', 'MATCH (a) WHERE a.tenantId = $tenantId RETURN a'),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});
