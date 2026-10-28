// Fakes for the platform-operator BFF tests (#838): the in-memory Valkey, clock and scriptable OIDC client from the
// tenant auth helpers, wired to the operator service with its own keys, store layout and record parser.

import { randomBytes } from 'node:crypto';

import {
  createOperatorAuthService,
  type OperatorAuditEvent,
  type OperatorAuthService,
} from './service';
import { createOperatorSessionStore, type OperatorSessionStore } from './session-store';
import {
  type Clock,
  CONSOLE_ORIGIN,
  fakeOidc,
  type FakeOidc,
  memoryValkey,
  type MemoryValkey,
} from '../auth/auth.test-helpers';
import { KEY_BYTES, seal } from '../auth/seal';

import type { OperatorAuthMetrics } from './metrics';
import type { TokenSet } from '../auth/oidc';
import type { JWTPayload } from 'jose';

export const OPERATOR_ID = 'op-0001';
const LOGIN_TTL_MS = 600_000;

/** Claims of an operator ID token after the second factor (the realm maps `acr` to `operator_strong`). */
export function operatorClaims(
  overrides: Partial<JWTPayload> & Record<string, unknown> = {},
): JWTPayload {
  return {
    sub: OPERATOR_ID,
    email: 'ops@blackwing.test',
    name: 'Ops Operator',
    acr: 'operator_strong',
    roles: ['platform_operator'],
    ...overrides,
  };
}

export function operatorTokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: 'operator-access-1',
    refreshToken: 'operator-refresh-1',
    idToken: 'operator-id-1',
    expiresInSeconds: 300,
    refreshExpiresInSeconds: 1800,
    claims: operatorClaims(),
    ...overrides,
  };
}

export interface OperatorHarness {
  readonly clock: Clock;
  readonly valkey: MemoryValkey;
  readonly store: OperatorSessionStore;
  readonly oidc: FakeOidc;
  readonly service: OperatorAuthService;
  readonly audit: OperatorAuditEvent[];
  readonly metrics: { login: string[]; refresh: string[]; logout: number; mfaRequired: number };
  readonly keys: readonly [Buffer, ...Buffer[]];
  /** A separate tenant key, for the cross-cookie negatives. */
  readonly tenantKey: Buffer;
}

export function operatorHarness(clock: Clock): OperatorHarness {
  const valkey = memoryValkey(clock);
  const keys: readonly [Buffer, ...Buffer[]] = [randomBytes(KEY_BYTES)];
  const store: OperatorSessionStore = createOperatorSessionStore(valkey, keys, clock.read);
  const oidc = fakeOidc();
  const audit: OperatorAuditEvent[] = [];
  const counts = { login: [] as string[], refresh: [] as string[], logout: 0, mfaRequired: 0 };
  const metrics: OperatorAuthMetrics = {
    login: (result) => counts.login.push(result),
    refresh: (result) => counts.refresh.push(result),
    mfaRequired: () => {
      counts.mfaRequired += 1;
    },
    logout: () => {
      counts.logout += 1;
    },
  };
  const service = createOperatorAuthService({
    config: { consoleOrigin: CONSOLE_ORIGIN, sessionKeys: keys },
    oidc,
    store,
    metrics,
    audit: (event) => audit.push(event),
    now: clock.read,
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  return {
    clock,
    valkey,
    store,
    oidc,
    service,
    audit,
    metrics: counts,
    keys,
    tenantKey: randomBytes(KEY_BYTES),
  };
}

/** A tenant-realm login cookie (purpose `login-cookie`), to prove the operator callback never accepts one. */
export function tenantLoginCookie(key: Buffer, now: number): string {
  return seal(
    key,
    'login-cookie',
    { state: 's', nonce: 'n', verifier: 'v', returnTo: '/' },
    LOGIN_TTL_MS,
    now,
  );
}
