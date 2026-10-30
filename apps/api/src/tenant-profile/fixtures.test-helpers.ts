import { NotFoundError } from '@blackwing/errors';

import type { TenantProfileRecord, TenantProfileStore, TenantProfileWrite } from './ports.js';
import type { TenantSettingsMemberships } from '../tenant-settings/ports.js';

export const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
export const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
export const ADMIN_A = '0198f0a0-0000-7000-8000-0000000000a1';
export const AUDITOR_A = '0198f0a0-0000-7000-8000-0000000000a2';
export const ADMIN_B = '0198f0a0-0000-7000-8000-0000000000b1';

const BASE_TIME = Date.parse('2026-10-01T10:00:00.000Z');
const STEP_MS = 1000;

/** A stored profile row, as the adapter would return it. */
export function profileOf(
  overrides: Partial<TenantProfileRecord> = {},
  settings: Record<string, unknown> = { displayTimezone: 'Europe/Berlin' },
): TenantProfileRecord {
  return {
    name: 'Acme Security',
    slug: 'acme',
    region: 'eu-west-1',
    plan: 'team',
    status: 'active',
    settings,
    updatedAt: new Date(BASE_TIME),
    ...overrides,
  };
}

export interface MemoryProfileStore extends TenantProfileStore {
  readonly rows: Map<string, TenantProfileRecord>;
  readonly audits: { tenantId: string; actorId: string; changes: TenantProfileWrite['changes'] }[];
  /** Times `update` ran `mutate`, including refused ones. */
  readonly mutations: { count: number };
}

/**
 * In-memory profile store with the Postgres adapter's contract: `update` runs `mutate` on the current row,
 * a throw leaves it untouched, and a committed write bumps `updatedAt` and records its audit.
 */
export function memoryProfileStore(
  initial: Record<string, TenantProfileRecord>,
): MemoryProfileStore {
  const rows = new Map(Object.entries(initial));
  const audits: MemoryProfileStore['audits'] = [];
  const mutations = { count: 0 };
  let tick = 0;
  const apply = (
    tenantId: string,
    mutate: (current: TenantProfileRecord) => TenantProfileWrite | undefined,
  ) => {
    const current = rows.get(tenantId);
    if (current === undefined) throw new NotFoundError('tenant not found');
    mutations.count += 1;
    const write = mutate(current);
    if (write === undefined) return { record: current, changed: false };
    tick += 1;
    const next: TenantProfileRecord = {
      ...current,
      name: write.name,
      settings: write.settings,
      updatedAt: new Date(BASE_TIME + tick * STEP_MS),
    };
    rows.set(tenantId, next);
    audits.push({ tenantId, actorId: write.actorId, changes: write.changes });
    return { record: next, changed: true };
  };
  return {
    rows,
    audits,
    mutations,
    read: (tenantId) => Promise.resolve(rows.get(tenantId)),
    update: (tenantId, mutate) =>
      new Promise((resolve, reject) => {
        try {
          resolve(apply(tenantId, mutate));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  };
}

/** Roles per (tenant, user). Anyone not listed holds no membership in that tenant. */
export function memoryMemberships(
  roles: Record<string, Record<string, readonly string[]>>,
): TenantSettingsMemberships {
  return {
    rolesOf: (tenantId, userId) => Promise.resolve(roles[tenantId]?.[userId] ?? []),
  };
}
