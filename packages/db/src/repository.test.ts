import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TenantContextMissingError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { WidgetRepository } from './examples/widget.repository.js';
import { widgets } from './examples/widget.table.js';
import {
  BaseRepository,
  ConcurrencyError,
  CursorInvalidError,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  ForeignKeyError,
  MAX_PAGE_LIMIT,
} from './repository.js';

import type { Database } from './client.js';

/** A database that fails the test if anything reaches it. */
const untouchedDb = new Proxy(
  {},
  {
    get() {
      throw new Error('the database must not be reached');
    },
  },
) as Database;

function repo(tenant: () => string | undefined) {
  return new WidgetRepository({ db: untouchedDb, tenant });
}

describe('cursor encoding', () => {
  it('round-trips any position (property)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(0), max: new Date('9999-12-31'), noInvalidDate: true }),
        fc.uuid(),
        (createdAt, id) => {
          const decoded = decodeCursor(encodeCursor({ createdAt, id }));
          expect(decoded.createdAt.getTime()).toBe(createdAt.getTime());
          expect(decoded.id).toBe(id);
        },
      ),
    );
  });

  it('is opaque base64url', () => {
    const cursor = encodeCursor({ createdAt: new Date(0), id: newId() });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects every non-cursor string as cursor_invalid', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        // Random text is never a well-formed cursor; the only acceptable outcome is the typed error.
        expect(() => decodeCursor(value)).toThrow(CursorInvalidError);
      }),
    );
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'a b+/='],
    ['too long', 'A'.repeat(513)],
    ['not json', Buffer.from('xx').toString('base64url')],
    ['wrong shape', Buffer.from('{"t":1,"i":2}').toString('base64url')],
    [
      'extra field',
      Buffer.from(JSON.stringify({ t: new Date(0).toISOString(), i: newId(), z: 1 })).toString(
        'base64url',
      ),
    ],
    [
      'bad uuid',
      Buffer.from(JSON.stringify({ t: new Date(0).toISOString(), i: 'zzz' })).toString('base64url'),
    ],
    ['bad date', Buffer.from(JSON.stringify({ t: 'tomorrow', i: newId() })).toString('base64url')],
  ])('rejects a %s cursor', (_label, value) => {
    expect(() => decodeCursor(value)).toThrow(CursorInvalidError);
  });

  it('carries the machine reason cursor_invalid and a 422', () => {
    const error = new CursorInvalidError();
    expect(error.reason).toBe('cursor_invalid');
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', httpStatus: 422 });
  });
});

describe('errors', () => {
  it('ConcurrencyError is a 412 and ForeignKeyError a 409, neither leaks row data', () => {
    const stale = new ConcurrencyError('widget');
    expect(stale).toMatchObject({
      code: 'PRECONDITION_FAILED',
      httpStatus: 412,
      name: 'ConcurrencyError',
    });
    const fk = new ForeignKeyError('widget', 'widgets_parent_fk');
    expect(fk).toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      constraint: 'widgets_parent_fk',
    });
  });
});

describe('boundary checks (no database reached)', () => {
  it('requires the ambient tenant context for every method', async () => {
    const none = repo(() => undefined);
    const empty = repo(() => '');
    const id = newId();
    for (const r of [none, empty]) {
      await expect(r.findById(id)).rejects.toBeInstanceOf(TenantContextMissingError);
      await expect(r.list()).rejects.toBeInstanceOf(TenantContextMissingError);
      await expect(r.create({ name: 'x' })).rejects.toBeInstanceOf(TenantContextMissingError);
      await expect(r.update(id, 0, {})).rejects.toBeInstanceOf(TenantContextMissingError);
      await expect(r.softDelete(id)).rejects.toBeInstanceOf(TenantContextMissingError);
      await expect(r.delete(id)).rejects.toBeInstanceOf(TenantContextMissingError);
    }
  });

  it('rejects a malformed tenant context before touching the database', async () => {
    await expect(repo(() => 'not-a-uuid').list()).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('validates inputs with Zod before any query', async () => {
    const r = repo(() => newId());
    const id = newId();
    await expect(r.findById('nope')).rejects.toBeInstanceOf(ValidationError);
    await expect(r.create({ name: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(r.create({ name: 'x', tenantId: newId() } as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(r.update(id, 1.5, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(r.update(id, -1, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(r.update(id, 0, { id: newId() } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(r.softDelete(id, 2 ** 31)).rejects.toBeInstanceOf(ValidationError);
    await expect(r.list({ limit: MAX_PAGE_LIMIT + 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(r.list({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(r.list({ cursor: 'forged' })).rejects.toBeInstanceOf(CursorInvalidError);
    await expect(r.list({ unknown: true } as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it('puts field paths, never values, in validation details', async () => {
    const r = repo(() => newId());
    const error = await r.create({ name: 'x', quantity: -5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).detail).toContain('quantity');
    expect((error as ValidationError).detail).not.toContain('-5');
  });

  it('documents the limits', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(MAX_PAGE_LIMIT).toBe(200);
  });

  it('is a thin composition target: any table with the mixins fits', () => {
    const generic = new BaseRepository({
      entity: 'thing',
      table: widgets,
      db: untouchedDb,
      tenant: () => undefined,
      createSchema: z.object({ name: z.string() }),
      updateSchema: z.object({ name: z.string().optional() }),
    });
    expect(generic).toBeInstanceOf(BaseRepository);
  });
});
