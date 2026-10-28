import { NotFoundError } from '@blackwing/errors';

import type {
  TenantSettingsMemberships,
  TenantSettingsRecord,
  TenantSettingsStore,
  TenantSettingsWrite,
} from './ports.js';

export const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
export const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
export const ADMIN_A = '0198f0a0-0000-7000-8000-0000000000a1';
export const AUDITOR_A = '0198f0a0-0000-7000-8000-0000000000a2';
export const ADMIN_B = '0198f0a0-0000-7000-8000-0000000000b1';

export const BASE_TIME = Date.parse('2026-10-01T10:00:00.000Z');
/** Spacing of the fake clock between writes. */
const STEP_MS = 1000;

/** A row of the fake store, as the adapter would return it. */
export function recordOf(
  settings: Record<string, unknown> = {},
  updatedAtMs = BASE_TIME,
): TenantSettingsRecord {
  return { settings, region: 'eu-west-1', updatedAt: new Date(updatedAtMs) };
}

export interface MemoryStore extends TenantSettingsStore {
  readonly rows: Map<string, TenantSettingsRecord>;
  readonly audits: { tenantId: string; actorId: string; changes: TenantSettingsWrite['changes'] }[];
  /** Number of times `update` ran `mutate` (including refused ones). */
  readonly mutations: { count: number };
}

/**
 * In-memory tenant settings store with the same contract as the Postgres adapter: `update` runs `mutate`
 * on the current row, throws leave it untouched, and a write bumps `updatedAt` and records its audit.
 */
export function memoryStore(initial: Record<string, TenantSettingsRecord>): MemoryStore {
  const rows = new Map(Object.entries(initial));
  const audits: MemoryStore['audits'] = [];
  const mutations = { count: 0 };
  let tick = 0;
  const apply = (tenantId: string, mutate: Parameters<TenantSettingsStore['update']>[1]) => {
    const current = rows.get(tenantId);
    if (current === undefined) throw new NotFoundError('tenant not found');
    mutations.count += 1;
    const write = mutate(current);
    if (write === undefined) return { record: current, changed: false };
    tick += 1;
    const next: TenantSettingsRecord = {
      settings: write.settings,
      region: current.region,
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
      new Promise((resolve) => {
        resolve(apply(tenantId, mutate));
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
