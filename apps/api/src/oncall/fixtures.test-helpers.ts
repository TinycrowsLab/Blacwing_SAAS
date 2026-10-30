import { Writable } from 'node:stream';

import { Registry } from 'prom-client';

import { newId } from '@blackwing/ids';
import { createLogger, type Logger } from '@blackwing/logger';
import { FixedClock } from '@blackwing/time';

import {
  InMemoryOncallAuditSink,
  InMemoryOncallExceptionReader,
  InMemoryOncallStore,
} from './memory.js';
import { createOncallMetrics, type OncallMetrics } from './metrics.js';
import { OncallService, type OncallServiceDeps } from './service.js';

import type { OncallPrincipal } from './ports.js';

/** The instant every test starts at: a Friday in late October, outside any DST change. */
const NOW = new Date('2026-10-30T10:00:00.000Z');

export const TENANT_A = newId();
export const TENANT_B = newId();
export const ADMIN = newId();
export const ADMIN_B = newId();
export const AUDITOR = newId();
export const REQUESTER = newId();
export const PLAN_APPROVER = newId();
export const PRIMARY = newId();
export const SECONDARY = newId();
export const MANAGER = newId();

export function principal(
  tenantId: string,
  userId: string,
  roles: readonly string[] = ['org_admin'],
): OncallPrincipal {
  return { type: 'user', id: userId, tenantId, roles };
}

/** A logger that keeps its JSON lines, so tests can assert on the structured events. */
function captureLogger(): { logger: Logger; events: () => string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger('api', { level: 'debug', nodeEnv: 'test', destination });
  return {
    logger,
    events: () => lines.map((line) => (JSON.parse(line) as { msg: string }).msg),
  };
}

export interface Harness {
  readonly service: OncallService;
  readonly store: InMemoryOncallStore;
  readonly audit: InMemoryOncallAuditSink;
  readonly exceptions: InMemoryOncallExceptionReader;
  readonly metrics: OncallMetrics;
  readonly registry: Registry;
  readonly events: () => string[];
  readonly clock: FixedClock;
}

/** A service over in-memory adapters, with a fixed clock, a capturing logger and its own metrics. */
export function harness(overrides: Partial<OncallServiceDeps> = {}): Harness {
  const registry = new Registry();
  const metrics = createOncallMetrics(registry);
  const store = new InMemoryOncallStore();
  const audit = new InMemoryOncallAuditSink();
  const exceptions = new InMemoryOncallExceptionReader();
  const clock = new FixedClock(NOW);
  const { logger, events } = captureLogger();
  const service = new OncallService({
    store,
    exceptions,
    audit,
    logger,
    metrics,
    clock,
    ...overrides,
  });
  return { service, store, audit, exceptions, metrics, registry, events, clock };
}
