// Fakes shared by the auth unit tests (IAM-002, #334): an in-memory Valkey with TTLs on a controllable
// clock, a scriptable OIDC client and a service wired to both.

import { randomBytes } from 'node:crypto';

import { vi } from 'vitest';

import { createSessionRevoker, type SessionRevoker } from './revocation.js';
import { KEY_BYTES } from './seal.js';
import {
  createAuthService,
  type AuthAuditEvent,
  type AuthService,
  type AuthDeps,
} from './service.js';
import {
  createSessionStore,
  type SessionRecord,
  type SessionStore,
  type ValkeyLike,
} from './session-store.js';

import type { AuthMetrics } from './metrics.js';
import type { OidcClient, TokenSet } from './oidc.js';
import type { JWTPayload } from 'jose';

export const CONSOLE_ORIGIN = 'https://app.example.com';
const START = 1_800_000_000_000;

export class Clock {
  now = START;
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

export interface MemoryValkey extends ValkeyLike {
  readonly data: Map<string, { value: string; expiresAt: number }>;
  /** Index sets, with the time each one expires. */
  readonly sets: Map<string, { members: Set<string>; expiresAt: number }>;
  /** How many commands were sent (a batch of N members must cost O(N / batch) commands). */
  commands: number;
  failing: boolean;
}

/** An in-memory Valkey: string keys and sets with TTLs on the injected clock. */
export function memoryValkey(clock: Clock): MemoryValkey {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const sets = new Map<string, { members: Set<string>; expiresAt: number }>();
  const live = (key: string): string | null => {
    const entry = data.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= clock.now) {
      data.delete(key);
      return null;
    }
    return entry.value;
  };
  const liveSet = (key: string): Set<string> => {
    const entry = sets.get(key);
    if (entry === undefined || entry.expiresAt <= clock.now) {
      sets.delete(key);
      return new Set();
    }
    return entry.members;
  };
  const fail = (): Promise<never> => Promise.reject(new Error('down'));
  const valkey: MemoryValkey = {
    data,
    sets,
    commands: 0,
    failing: false,
    get(key) {
      this.commands += 1;
      return this.failing ? fail() : Promise.resolve(live(key));
    },
    setPx(key, value, ms, mode) {
      this.commands += 1;
      if (this.failing) return fail();
      const exists = live(key) !== null;
      if ((mode === 'NX' && exists) || (mode === 'XX' && !exists)) return Promise.resolve(null);
      data.set(key, { value, expiresAt: clock.now + ms });
      return Promise.resolve('OK');
    },
    del(key) {
      this.commands += 1;
      if (this.failing) return fail();
      return Promise.resolve(data.delete(key));
    },
    delMany(keys) {
      this.commands += 1;
      if (this.failing) return fail();
      for (const key of keys) data.delete(key);
      return Promise.resolve(keys.length);
    },
    delIfEquals(key, token) {
      this.commands += 1;
      if (this.failing) return fail();
      if (live(key) === token) data.delete(key);
      return Promise.resolve();
    },
    mget(keys) {
      this.commands += 1;
      if (this.failing) return fail();
      return Promise.resolve(keys.map((key) => live(key)));
    },
    sadd(key, member) {
      this.commands += 1;
      if (this.failing) return fail();
      const members = liveSet(key);
      members.add(member);
      if (!sets.has(key)) sets.set(key, { members, expiresAt: Infinity });
      return Promise.resolve(1);
    },
    srem(key, members) {
      this.commands += 1;
      if (this.failing) return fail();
      const set = liveSet(key);
      for (const member of members) set.delete(member);
      return Promise.resolve(members.length);
    },
    sscan(key, cursor, count) {
      this.commands += 1;
      if (this.failing) return fail();
      // Keyed by the last member returned, so members removed mid-walk never shift the next page
      // (the guarantee real SSCAN gives for members present throughout).
      const after = cursor === '0' ? '' : cursor;
      const remaining = [...liveSet(key)].filter((m) => m > after).sort();
      const page = remaining.slice(0, count);
      const next = remaining.length > count ? (page[page.length - 1] ?? '0') : '0';
      return Promise.resolve([next, page]);
    },
    pexpire(key, ms) {
      this.commands += 1;
      if (this.failing) return fail();
      const entry = sets.get(key);
      if (entry !== undefined) entry.expiresAt = clock.now + ms;
      return Promise.resolve(1);
    },
  };
  return valkey;
}

export const sessionRecord: SessionRecord = {
  sub: 'user-1',
  email: 'owner@acme.test',
  name: 'Olive Owner',
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  roles: ['asset_owner'],
  accessToken: 'plain-access-token',
  refreshToken: 'plain-refresh-token',
  idToken: 'plain-id-token',
  accessExpiresAt: START,
  csrf: 'csrf-secret',
};

export function claims(overrides: Partial<JWTPayload> & Record<string, unknown> = {}): JWTPayload {
  return {
    sub: 'user-1',
    email: 'owner@acme.test',
    name: 'Olive Owner',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    roles: ['asset_owner'],
    ...overrides,
  };
}

export function tokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    idToken: 'id-token-1',
    expiresInSeconds: 300,
    refreshExpiresInSeconds: 1800,
    claims: claims(),
    ...overrides,
  };
}

export interface FakeOidc extends OidcClient {
  readonly authorizationUrl: ReturnType<typeof vi.fn<OidcClient['authorizationUrl']>>;
  readonly exchangeCode: ReturnType<typeof vi.fn<OidcClient['exchangeCode']>>;
  readonly refresh: ReturnType<typeof vi.fn<OidcClient['refresh']>>;
  readonly endSessionUrl: ReturnType<typeof vi.fn<OidcClient['endSessionUrl']>>;
  readonly verifyLogoutToken: ReturnType<typeof vi.fn<OidcClient['verifyLogoutToken']>>;
}

export function fakeOidc(): FakeOidc {
  return {
    authorizationUrl: vi.fn<OidcClient['authorizationUrl']>(({ state, nonce, challenge }) =>
      Promise.resolve(
        new URL(
          `https://id.example.com/auth?state=${state}&nonce=${nonce}&code_challenge=${challenge}&code_challenge_method=S256`,
        ),
      ),
    ),
    exchangeCode: vi.fn<OidcClient['exchangeCode']>(() => Promise.resolve(tokens())),
    refresh: vi.fn<OidcClient['refresh']>(() => Promise.resolve(tokens())),
    endSessionUrl: vi.fn<OidcClient['endSessionUrl']>(({ idToken }) =>
      Promise.resolve(new URL(`https://id.example.com/logout?id_token_hint=${idToken ?? ''}`)),
    ),
    verifyLogoutToken: vi.fn<OidcClient['verifyLogoutToken']>(() =>
      Promise.resolve({ sub: 'user-1', sid: 'idp-sid-1', jti: 'jti-1' }),
    ),
  };
}

export interface Harness {
  readonly clock: Clock;
  readonly valkey: MemoryValkey;
  readonly store: SessionStore;
  readonly oidc: FakeOidc;
  readonly service: AuthService;
  readonly revocation: SessionRevoker;
  readonly audit: AuthAuditEvent[];
  readonly metrics: {
    login: string[];
    refresh: string[];
    logout: number;
    backchannel: string[];
    revocations: string[];
  };
  readonly keys: readonly [Buffer, ...Buffer[]];
}

export function harness(overrides: Partial<Pick<AuthDeps, 'sleep'>> = {}): Harness {
  const clock = new Clock();
  const valkey = memoryValkey(clock);
  const keys: readonly [Buffer, ...Buffer[]] = [randomBytes(KEY_BYTES)];
  const store = createSessionStore(valkey, keys, clock.read);
  const oidc = fakeOidc();
  const audit: AuthAuditEvent[] = [];
  const counts = {
    login: [] as string[],
    refresh: [] as string[],
    logout: 0,
    backchannel: [] as string[],
    revocations: [] as string[],
  };
  const metrics: AuthMetrics = {
    login: (result) => counts.login.push(result),
    refresh: (result) => counts.refresh.push(result),
    logout: () => {
      counts.logout += 1;
    },
    backchannelLogout: (result) => counts.backchannel.push(result),
    sessionRevocation: (scope) => counts.revocations.push(scope),
  };
  const service = createAuthService({
    config: { consoleOrigin: CONSOLE_ORIGIN, sessionKeys: keys },
    oidc,
    store,
    metrics,
    audit: (event) => audit.push(event),
    now: clock.read,
    sleep:
      overrides.sleep ??
      ((ms) => {
        clock.advance(ms);
        return Promise.resolve();
      }),
  });
  const revocation = createSessionRevoker({
    store,
    metrics,
    audit: (event) => audit.push(event),
    logger: { warn: () => undefined },
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  return { clock, valkey, store, oidc, service, revocation, audit, metrics: counts, keys };
}
