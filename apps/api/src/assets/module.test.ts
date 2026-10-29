import { describe, expect, it } from 'vitest';

import { AssetListController } from './controller.js';
import { AssetListModule } from './module.js';
import { ASSET_LIST_SERVICE } from './tokens.js';

import type { AssetListMemberships, AssetListStore } from './ports.js';

const store: AssetListStore = { list: () => Promise.resolve([]) };
const memberships: AssetListMemberships = { rolesOf: () => Promise.resolve([]) };

describe('AssetListModule', () => {
  it('mounts the asset-list controller behind its service token', () => {
    const dynamic = AssetListModule.forRoot({ store, memberships });
    expect(dynamic.module).toBe(AssetListModule);
    expect(dynamic.controllers).toEqual([AssetListController]);
    expect(
      dynamic.providers?.map((provider) => (provider as { provide: unknown }).provide),
    ).toEqual([ASSET_LIST_SERVICE]);
  });
});
