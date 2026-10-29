import { describe, expect, it, vi } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { AssetListController } from './controller.js';

import type { AssetListService } from './service.js';
import type { FastifyReply } from 'fastify';

const TENANT = '0198f0a0-0000-7000-8000-00000000000a';
const USER = '0198f0a0-0000-7000-8000-0000000000a1';

vi.mock('@blackwing/db/tenant-context', () => ({
  getTenantContextOrThrow: () => ({ tenantId: TENANT, actor: { id: USER } }),
}));

const ANSWER = { items: [] };

function fakeService() {
  const list = vi.fn<
    (principal: { tenantId: string; actorId: string }, query: unknown) => Promise<unknown>
  >(() => Promise.resolve(ANSWER));
  return { service: { list } as unknown as AssetListService, list };
}

/** A reply that records the headers the controller sets. */
function fakeReply() {
  const headers: Record<string, string> = {};
  const reply = {
    header: (name: string, value: string) => {
      headers[name] = value;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, headers };
}

describe('AssetListController (GET /v1/assets)', () => {
  it('answers the service with the tenant and actor from the context, and never caches the answer', async () => {
    const { service, list } = fakeService();
    const { reply, headers } = fakeReply();
    const controller = new AssetListController(service);
    await expect(controller.list({ verificationStatus: 'verified' }, reply)).resolves.toEqual(
      ANSWER,
    );
    expect(list).toHaveBeenCalledWith(
      { tenantId: TENANT, actorId: USER },
      { verificationStatus: 'verified' },
    );
    expect(headers['cache-control']).toBe('no-store');
  });

  it('refuses an unknown query parameter as a 400 and never reaches the service', async () => {
    const { service, list } = fakeService();
    const { reply } = fakeReply();
    const controller = new AssetListController(service);
    await expect(controller.list({ tenantId: 'other-tenant' }, reply)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses an unknown verification state as a 400 and never reaches the service', async () => {
    const { service, list } = fakeService();
    const { reply } = fakeReply();
    const controller = new AssetListController(service);
    await expect(controller.list({ verificationStatus: 'maybe' }, reply)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(list).not.toHaveBeenCalled();
  });
});
