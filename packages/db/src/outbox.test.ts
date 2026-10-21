// withOutbox against a fake transaction: tenant context, validation, redaction, error mapping,
// logging and metrics (no database). Atomicity, RLS and the unique index are in outbox.int.test.ts.

import { describe, expect, it } from 'vitest';

import { OUTBOX_PAYLOAD_MAX_BYTES } from '@blackwing/contracts';
import { ForbiddenError, TenantContextMissingError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  OutboxDuplicateError,
  type OutboxMetrics,
  withOutbox,
  type WithOutboxOptions,
} from './outbox.js';
import { OUTBOX_DEDUPE_INDEX, type NewOutboxRow } from './schema/outbox.js';

import type { TenantTx } from './with-tenant.js';
import type { Logger } from '@blackwing/logger';

const TENANT = newId();
const AGGREGATE = newId();
const message = { type: 'audit.event', payload: { action: 'run.created' } } as const;

interface FakeTx {
  readonly tx: TenantTx;
  readonly inserts: NewOutboxRow[][];
  readonly executes: number;
}

/** A transaction whose `app.tenant_id` reads as `tenant`; `insertError` makes the insert reject. */
function fakeTx(tenant: string | null | undefined, insertError?: Error): FakeTx {
  const state = { inserts: [] as NewOutboxRow[][], executes: 0 };
  const tx = {
    execute: () => {
      state.executes += 1;
      return Promise.resolve({ rows: [{ tenant_id: tenant }] });
    },
    insert: () => ({
      values: (rows: NewOutboxRow[]) => {
        if (insertError !== undefined) return Promise.reject(insertError);
        state.inserts.push(rows);
        return Promise.resolve();
      },
    }),
  } as unknown as TenantTx;
  return {
    tx,
    inserts: state.inserts,
    get executes() {
      return state.executes;
    },
  };
}

interface Line {
  readonly bindings: Record<string, unknown>;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function captureLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const logger = {
    child: (bindings: Record<string, unknown>) => ({
      info: (fields: Record<string, unknown>, text: string) => {
        lines.push({ bindings, fields, message: text });
      },
    }),
  } as unknown as Logger;
  return { logger, lines };
}

/** `withOutbox` with a silent logger by default, so the suite prints no insert lines. */
const quiet = captureLogger().logger;
function send(
  tx: TenantTx,
  messages: Parameters<typeof withOutbox>[1],
  options: WithOutboxOptions = {},
): ReturnType<typeof withOutbox> {
  return withOutbox(tx, messages, { logger: quiet, ...options });
}

function captureMetrics(): { metrics: OutboxMetrics; calls: [string, number][] } {
  const calls: [string, number][] = [];
  return {
    metrics: {
      rowsWritten: (type, count) => {
        calls.push([type, count]);
      },
    },
    calls,
  };
}

/** A pg-style error, wrapped the way Drizzle wraps driver errors (`cause`). */
function pgError(code: string, extra: Record<string, unknown> = {}, message = 'pg'): Error {
  const driver = Object.assign(new Error(message), { code, ...extra });
  return new Error('Failed query: insert into "outbox"', { cause: driver });
}

describe('withOutbox: tenant context (fail closed)', () => {
  it.each([
    ['unset (NULL)', null],
    ['reset (empty string)', ''],
    ['missing row', undefined],
    ['malformed', 'not-a-uuid'],
    ['injection attempt', `${TENANT}'; DROP TABLE outbox; --`],
  ])('refuses to write when app.tenant_id is %s', async (_label, tenant) => {
    const fake = fakeTx(tenant);
    await expect(send(fake.tx, [message])).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(fake.inserts).toEqual([]);
  });

  it('has the stable TENANT_CONTEXT_MISSING code and is not retryable', async () => {
    const error = await send(fakeTx(null).tx, [message]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'TENANT_CONTEXT_MISSING', retryable: false });
  });

  it('requires the context even for an empty batch, which then writes nothing', async () => {
    await expect(send(fakeTx(null).tx, [])).rejects.toBeInstanceOf(TenantContextMissingError);
    const fake = fakeTx(TENANT);
    await expect(send(fake.tx, [])).resolves.toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it('checks the context before validating the messages', async () => {
    await expect(send(fakeTx(null).tx, [{ nope: true } as never])).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('takes the tenant from the transaction, never from the message', async () => {
    const fake = fakeTx(TENANT.toUpperCase());
    await send(fake.tx, [message]);
    expect(fake.inserts[0]?.[0]?.tenantId).toBe(TENANT);

    const forged = { ...message, tenantId: newId() } as never;
    await expect(send(fakeTx(TENANT).tx, [forged])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('withOutbox: insert', () => {
  it('inserts every message in one statement, in order, with fresh UUIDv7 ids', async () => {
    const fake = fakeTx(TENANT);
    const ids = await send(fake.tx, [
      { ...message, dedupeKey: 'a' },
      {
        type: 'temporal.signal',
        aggregateType: 'run',
        aggregateId: AGGREGATE,
        payload: { signal: 'kill', n: [1, 2] },
      },
    ]);
    expect(fake.inserts).toHaveLength(1);
    const rows = fake.inserts[0] ?? [];
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT,
      type: 'audit.event',
      aggregateType: null,
      aggregateId: null,
      payload: { action: 'run.created' },
      dedupeKey: 'a',
    });
    expect(rows[1]).toMatchObject({
      type: 'temporal.signal',
      aggregateType: 'run',
      aggregateId: AGGREGATE,
      dedupeKey: null,
    });
  });

  it('leaves status, attempts and every timestamp to the database defaults', async () => {
    const fake = fakeTx(TENANT);
    await send(fake.tx, [message]);
    const row = fake.inserts[0]?.[0] ?? {};
    for (const column of ['status', 'attempts', 'availableAt', 'createdAt', 'dispatchedAt']) {
      expect(row).not.toHaveProperty(column);
    }
  });

  it('rejects an availableAt from the caller (DB now() only)', async () => {
    const skewed = { ...message, availableAt: '2099-01-01T00:00:00.000Z' } as never;
    await expect(send(fakeTx(TENANT).tx, [skewed])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('withOutbox: validation', () => {
  it('rejects an invalid message without writing any of the batch', async () => {
    const fake = fakeTx(TENANT);
    await expect(
      send(fake.tx, [message, { type: 'nope', payload: {} } as never]),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fake.inserts).toEqual([]);
  });

  it('rejects an oversized payload and points at payloadRef; the error never echoes the payload', async () => {
    const secretLooking = 'zz-do-not-echo-'.repeat(5000);
    const fake = fakeTx(TENANT);
    const error = await send(fake.tx, [{ ...message, payload: { blob: secretLooking } }]).catch(
      (e: unknown) => e as ValidationError,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain('payloadRef');
    expect(
      JSON.stringify([(error as Error).message, (error as ValidationError).detail]),
    ).not.toContain('do-not-echo');
    expect(fake.inserts).toEqual([]);
  });

  it('accepts a pointer to a stored body', async () => {
    const fake = fakeTx(TENANT);
    const payload = {
      payloadRef: { s3Key: 'tenants/t/outbox/1.json', sha256: 'b'.repeat(64), sizeBytes: 900_000 },
    };
    await send(fake.tx, [{ ...message, payload }]);
    expect(fake.inserts[0]?.[0]?.payload).toEqual(payload);
  });

  it('rejects more than the batch limit', async () => {
    await expect(
      send(
        fakeTx(TENANT).tx,
        Array.from({ length: 501 }, () => message),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a repeated dedupe key inside one batch before touching the database', async () => {
    const fake = fakeTx(TENANT);
    const error = await send(fake.tx, [
      { ...message, dedupeKey: 'same' },
      { ...message, dedupeKey: 'same' },
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboxDuplicateError);
    expect((error as OutboxDuplicateError).dedupeKey).toBe('same');
    expect(fake.inserts).toEqual([]);
  });

  it('allows several messages without a key', async () => {
    const fake = fakeTx(TENANT);
    await send(fake.tx, [message, message]);
    expect(fake.inserts[0]).toHaveLength(2);
  });
});

describe('withOutbox: redaction before insert (no secrets in payloads)', () => {
  const stored = async (payload: Record<string, unknown>): Promise<unknown> => {
    const fake = fakeTx(TENANT);
    await send(fake.tx, [{ ...message, payload: payload as never }]);
    return fake.inserts[0]?.[0]?.payload;
  };

  it('replaces values under secret-looking keys at any depth', async () => {
    expect(
      await stored({
        action: 'asset.credential.set',
        password: 'hunter2',
        nested: { apiKey: 'k', list: [{ clientSecret: 's' }] },
        secretRef: 'sec_01',
      }),
    ).toEqual({
      action: 'asset.credential.set',
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', list: [{ clientSecret: '[REDACTED]' }] },
      secretRef: 'sec_01',
    });
  });

  it('replaces credential shapes inside strings', async () => {
    const out = (await stored({
      note: 'called with Bearer abcdefghijklmnop1234',
      pat: 'bw_pat_abc123',
      url: 'https://user:pw@host.example/path',
      plain: 'nothing to hide',
    })) as Record<string, string>;
    expect(out.note).not.toContain('abcdefghijklmnop1234');
    expect(out.pat).toBe('[REDACTED]');
    expect(out.url).not.toContain('user:pw');
    expect(out.plain).toBe('nothing to hide');
  });

  it('leaves LLM token counters and references alone', async () => {
    const payload = { inputTokens: 12, outputTokens: 3, evidenceKey: 'ev/1', tokenSha256Ref: 'x' };
    expect(await stored(payload)).toEqual(payload);
  });

  it('re-checks the cap after redaction, when [REDACTED] is longer than the value', async () => {
    const entries = Object.fromEntries(
      Array.from({ length: Math.ceil(OUTBOX_PAYLOAD_MAX_BYTES / 14) - 20 }, (_v, i) => [
        `t${String(i).padStart(5, '0')}_token`,
        'a',
      ]),
    );
    const fake = fakeTx(TENANT);
    await expect(send(fake.tx, [{ ...message, payload: entries }])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fake.inserts).toEqual([]);
  });
});

describe('withOutbox: database errors', () => {
  it('maps a duplicate (tenant, dedupe_key) to OutboxDuplicateError (409 CONFLICT)', async () => {
    const error = await send(
      fakeTx(TENANT, pgError('23505', { constraint: OUTBOX_DEDUPE_INDEX })).tx,
      [{ ...message, dedupeKey: 'run:1:created' }],
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboxDuplicateError);
    expect(error).toMatchObject({ code: 'CONFLICT', dedupeKey: 'run:1:created' });
  });

  it('does not claim a duplicate for another unique violation', async () => {
    const original = pgError('23505', { constraint: 'outbox_pkey' });
    await expect(send(fakeTx(TENANT, original).tx, [message])).rejects.toBe(original);
  });

  it('maps an RLS WITH CHECK violation to ForbiddenError', async () => {
    const error = pgError(
      '42501',
      {},
      'new row violates row-level security policy for table "outbox"',
    );
    await expect(send(fakeTx(TENANT, error).tx, [message])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rethrows unrelated failures unchanged', async () => {
    const original = new Error('connection terminated');
    await expect(send(fakeTx(TENANT, original).tx, [message])).rejects.toBe(original);
  });
});

describe('withOutbox: observability', () => {
  it('logs each insert with tenantId, type and dedupeKey, and counts rows per type', async () => {
    const { logger, lines } = captureLogger();
    const { metrics, calls } = captureMetrics();
    const ids = await send(
      fakeTx(TENANT).tx,
      [
        { ...message, dedupeKey: 'k1' },
        { type: 'notify.send', payload: { template: 'run.done' } },
        { ...message, dedupeKey: 'k2' },
      ],
      { logger, metrics },
    );
    expect(lines.map((line) => line.message)).toEqual([
      'outbox.insert',
      'outbox.insert',
      'outbox.insert',
    ]);
    expect(lines.every((line) => line.bindings.tenantId === TENANT)).toBe(true);
    expect(
      lines.map((line) => [line.fields.type, line.fields.dedupeKey, line.fields.outboxId]),
    ).toEqual([
      ['audit.event', 'k1', ids[0]],
      ['notify.send', null, ids[1]],
      ['audit.event', 'k2', ids[2]],
    ]);
    expect(calls).toEqual([
      ['audit.event', 2],
      ['notify.send', 1],
    ]);
  });

  it('never logs the payload', async () => {
    const { logger, lines } = captureLogger();
    await send(fakeTx(TENANT).tx, [{ ...message, payload: { subject: 'sensitive-body' } }], {
      logger,
    });
    expect(JSON.stringify(lines)).not.toContain('sensitive-body');
  });

  it('logs and counts nothing for a rejected write', async () => {
    const { logger, lines } = captureLogger();
    const { metrics, calls } = captureMetrics();
    await send(
      fakeTx(TENANT, pgError('23505', { constraint: OUTBOX_DEDUPE_INDEX })).tx,
      [message],
      {
        logger,
        metrics,
      },
    ).catch(() => undefined);
    await send(fakeTx(null).tx, [message], { logger, metrics }).catch(() => undefined);
    expect(lines).toEqual([]);
    expect(calls).toEqual([]);
  });
});
