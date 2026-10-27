import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { AppError } from '@blackwing/errors';
import { createUuidV7Generator } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';
import { createEnvelopeCrypto, type EnvelopeCrypto, type TransitClient } from '@blackwing/secrets';
import { FixedClock } from '@blackwing/time';

import {
  createInMemorySecretUsage,
  InMemorySecretAuditSink,
  InMemorySecretStore,
} from './memory.js';
import { createSecretMetrics } from './metrics.js';
import { createCedarSecretPolicy } from './policy.js';
import { SecretService } from './service.js';

import type { SecretPrincipal } from './ports.js';

const gen = createUuidV7Generator();
export const uuid = (): string => gen();

export const TENANT_A = uuid();
export const TENANT_B = uuid();
export const ADMIN_ID = uuid();

/** A value that must never show up in a response, a log line, an audit record, a span or a metric. */
export const VALUE = 'hunter2-S3cr3t-value-ffe1';

export const principal = (
  roles: readonly string[],
  overrides: Partial<SecretPrincipal> = {},
): SecretPrincipal => ({ type: 'user', id: ADMIN_ID, tenantId: TENANT_A, roles, ...overrides });

export const admin = principal(['org_admin']);
export const adminB = principal(['org_admin'], { tenantId: TENANT_B });

/** Roles that hold neither secret:write nor secret:read. */
export const NON_ADMIN_ROLES = [
  'appsec_engineer',
  'asset_owner',
  'developer',
  'auditor',
  'ci_pipeline',
] as const;

/** Transit stand-in: reversible, tenant-agnostic, can be taken down like a sealed OpenBao. */
export class FakeTransit implements TransitClient {
  down = false;

  private check(): void {
    if (this.down) throw new AppError('KEK_UNAVAILABLE', 'sealed');
  }

  encrypt(_key: string, plaintextB64: string): Promise<string> {
    this.check();
    return Promise.resolve(`vault:v1:${plaintextB64}`);
  }

  decrypt(_key: string, ciphertext: string): Promise<string> {
    this.check();
    return Promise.resolve(ciphertext.replace(/^vault:v1:/, ''));
  }

  rewrap(_key: string, ciphertext: string): Promise<string> {
    this.check();
    return Promise.resolve(ciphertext);
  }
}

export interface Harness {
  readonly service: SecretService;
  readonly store: InMemorySecretStore;
  readonly audit: InMemorySecretAuditSink;
  readonly crypto: EnvelopeCrypto;
  readonly transit: FakeTransit;
  readonly metrics: ReturnType<typeof createSecretMetrics>;
  readonly logs: string[];
  readonly spans: InMemorySpanExporter;
  readonly clock: FixedClock;
  /** References the usage reader reports (mutable: push to make a secret "in use"). */
  readonly references: { tenantId: string; secretId: string; resourceType: string }[];
}

export function harness(): Harness {
  const logs: string[] = [];
  const audit = new InMemorySecretAuditSink();
  const store = new InMemorySecretStore(audit);
  const transit = new FakeTransit();
  const crypto = createEnvelopeCrypto({ transit });
  const metrics = createSecretMetrics();
  const clock = new FixedClock('2026-10-22T10:00:00.000Z');
  const references: Harness['references'] = [];
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  const service = new SecretService({
    store,
    usage: {
      referencingTypes: (t, s) => createInMemorySecretUsage(references).referencingTypes(t, s),
    },
    crypto,
    audit,
    policy: createCedarSecretPolicy(),
    logger: createLogger('secrets-test', {
      level: 'debug',
      nodeEnv: 'test',
      destination: { write: (line: string) => logs.push(line) },
    }),
    metrics,
    clock,
    tracer: provider.getTracer('secrets-test'),
  });
  return { service, store, audit, crypto, transit, metrics, logs, spans, clock, references };
}

const KEY_DIGITS = 8;
let keySeq = 0;
/** A fresh, valid Idempotency-Key. */
export const freshKey = (): string => `key-${String((keySeq += 1)).padStart(KEY_DIGITS, '0')}`;
