// In-memory service-account store shared by the unit and HTTP tests (RBAC-005). Like the repository it only
// sees its own tenant's rows; the real RLS behaviour is proven by the integration test.

import {
  ConcurrencyError,
  ForeignKeyError,
  type RepositoryPage,
  type ServiceAccountRow,
} from '@blackwing/db';
import { NotFoundError } from '@blackwing/errors';

import type { ServiceAccountCreateValue, ServiceAccountUpdateValue } from './repository.js';
import type { ServiceAccountStore } from './service.js';

export interface Backing {
  readonly rows: Map<string, ServiceAccountRow>;
  /** Tenant id -> the user ids that are members of it (the owner foreign key). */
  readonly members: Map<string, Set<string>>;
  counter: number;
}

/** Width of the zero-padded counter in the generated test ids. */
const ID_COUNTER_WIDTH = 12;

export function emptyBacking(members: Map<string, Set<string>>): Backing {
  return { rows: new Map(), members, counter: 0 };
}

/** In-memory stand-in for the repository, bound to one tenant. */
export class InMemoryStore implements ServiceAccountStore {
  constructor(
    private readonly tenantId: string,
    private readonly backing: Backing,
  ) {}

  private mine(): ServiceAccountRow[] {
    return [...this.backing.rows.values()].filter((row) => row.tenantId === this.tenantId);
  }

  private nameTaken(name: string, exceptId?: string): boolean {
    return this.mine().some((row) => row.name === name && row.id !== exceptId);
  }

  insert(value: ServiceAccountCreateValue): Promise<ServiceAccountRow> {
    if (this.nameTaken(value.name))
      return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
    const members = this.backing.members.get(this.tenantId) ?? new Set<string>();
    if (!members.has(value.ownerUserId)) {
      return Promise.reject(new ForeignKeyError('service_account', 'service_accounts_owner_fk'));
    }
    this.backing.counter += 1;
    const now = new Date('2026-10-28T00:00:00.000Z');
    const row: ServiceAccountRow = {
      id: `0190a000-0000-7000-8000-${String(this.backing.counter).padStart(ID_COUNTER_WIDTH, '0')}`,
      tenantId: this.tenantId,
      name: value.name,
      description: value.description ?? null,
      roles: [...value.roles],
      ownerUserId: value.ownerUserId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      stateVersion: 0,
      deletedAt: null,
    };
    this.backing.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  patch(
    id: string,
    expectedVersion: number,
    changes: ServiceAccountUpdateValue,
  ): Promise<ServiceAccountRow> {
    const current = this.findRow(id);
    if (current === undefined)
      return Promise.reject(new NotFoundError('service account not found'));
    if (current.stateVersion !== expectedVersion)
      return Promise.reject(new ConcurrencyError('service_account'));
    if (changes.name !== undefined && this.nameTaken(changes.name, id)) {
      return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
    }
    const next: ServiceAccountRow = {
      ...current,
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.description === undefined ? {} : { description: changes.description }),
      ...(changes.roles === undefined ? {} : { roles: [...changes.roles] }),
      ...(changes.status === undefined ? {} : { status: changes.status }),
      stateVersion: current.stateVersion + 1,
    };
    this.backing.rows.set(id, next);
    return Promise.resolve(next);
  }

  disable(id: string, expectedVersion: number): Promise<ServiceAccountRow> {
    const current = this.findRow(id);
    if (current === undefined)
      return Promise.reject(new NotFoundError('service account not found'));
    if (current.stateVersion !== expectedVersion)
      return Promise.reject(new ConcurrencyError('service_account'));
    if (current.status === 'disabled') return Promise.resolve(current);
    const next = {
      ...current,
      status: 'disabled' as const,
      stateVersion: current.stateVersion + 1,
    };
    this.backing.rows.set(id, next);
    return Promise.resolve(next);
  }

  list(): Promise<RepositoryPage<ServiceAccountRow>> {
    return Promise.resolve({ items: this.mine(), nextCursor: null });
  }

  findById(id: string): Promise<ServiceAccountRow | undefined> {
    return Promise.resolve(this.findRow(id));
  }

  private findRow(id: string): ServiceAccountRow | undefined {
    const row = this.backing.rows.get(id);
    return row?.tenantId === this.tenantId ? row : undefined;
  }
}
