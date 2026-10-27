// Fakes shared by the auth unit tests (IAM-002, #334): an in-memory Valkey with TTLs on a controllable
// clock, a scriptable OIDC client and a service wired to both.

import { randomBytes } from 'node:crypto';

import { vi } from 'vitest';

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
  failing: boolean;
}

export function memoryValkey(clock: Clock): MemoryValkey {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string): string | null => {
    const entry = data.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= clock.now) {
      data.delete(key);
      return null;
    }
    return entry.value;
  };
  const valkey: MemoryValkey = {
    data,
    failing: false,
    get(key) {
      return this.failing ? Promise.reject(new Error('down')) : Promise.resolve(live(key));
    },
    setPx(key, value, ms, mode) {
      if (this.failing) return Promise.reject(new Error('down'));
      const exists = live(key) !== null;
      if ((mode === 'NX' && exists) || (mode === 'XX' && !exists)) return Promise.resolve(null);
      data.set(key, { value, expiresAt: clock.now + ms });
      return Promise.resolve('OK');
    },
    del(key) {
      if (this.failing) return Promise.reject(new Error('down'));
      return Promise.resolve(data.delete(key));
    },
    delIfEquals(key, token) {
      if (this.failing) return Promise.reject(new Error('down'));
      if (live(key) === token) data.delete(key);
      return Promise.resolve();
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
  };
}

export interface Harness {
  readonly clock: Clock;
  readonly valkey: MemoryValkey;
  readonly store: SessionStore;
  readonly oidc: FakeOidc;
  readonly service: AuthService;
  readonly audit: AuthAuditEvent[];
  readonly metrics: { login: string[]; refresh: string[]; logout: number };
  readonly keys: readonly [Buffer, ...Buffer[]];
}

export function harness(overrides: Partial<Pick<AuthDeps, 'sleep'>> = {}): Harness {
  const clock = new Clock();
  const valkey = memoryValkey(clock);
  const keys: readonly [Buffer, ...Buffer[]] = [randomBytes(KEY_BYTES)];
  const store = createSessionStore(valkey, keys, clock.read);
  const oidc = fakeOidc();
  const audit: AuthAuditEvent[] = [];
  const counts = { login: [] as string[], refresh: [] as string[], logout: 0 };
  const metrics: AuthMetrics = {
    login: (result) => counts.login.push(result),
    refresh: (result) => counts.refresh.push(result),
    logout: () => {
      counts.logout += 1;
    },
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
  return { clock, valkey, store, oidc, service, audit, metrics: counts, keys };
}
