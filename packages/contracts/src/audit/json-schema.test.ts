// The JSON Schema artifact and the cross-language hash vectors (AUDIT-001). Both files are committed
// so the Go egress gateway can use them without running TypeScript. When a file is missing this test
// writes it; when it drifts from the generated content the test fails. To regenerate after an
// intended contract change, delete the file and run `pnpm --filter @blackwing/contracts test`.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_GENESIS_PREV_HASH,
  auditEventHashInput,
  auditEventJsonSchema,
  AuditEventSchema,
  auditEventShapeSchema,
} from '../index.js';
import { minimalEvent, validEvent, validEventArbitrary } from './fixtures.test-helpers.js';

const SCHEMA_FILE = new URL('../../schemas/audit-event.schema.json', import.meta.url);
const VECTORS_FILE = new URL('../../test-vectors/audit-event-hash.json', import.meta.url);

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Writes `content` when the file is missing, then returns what is committed. */
function committed(file: URL, content: string): string {
  if (!existsSync(file)) {
    writeFileSync(file, content);
  }
  return readFileSync(file, 'utf8');
}

const addFormats = addFormatsPlugin as unknown as (ajv: Ajv2020) => Ajv2020;
const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));
const validateJsonSchema = ajv.compile(
  JSON.parse(committed(SCHEMA_FILE, serialise(auditEventJsonSchema()))) as object,
);

const zodAccepts = (value: unknown): boolean => auditEventShapeSchema.safeParse(value).success;
const jsonSchemaAccepts = (value: unknown): boolean => validateJsonSchema(value);

/** Structural fixtures: what each field accepts and rejects. */
function fixtures(): readonly {
  readonly name: string;
  readonly value: unknown;
  readonly valid: boolean;
}[] {
  const base = validEvent();
  const without = (field: string): Record<string, unknown> => {
    const event = validEvent();
    Reflect.deleteProperty(event, field);
    return event;
  };
  return [
    { name: 'full event', value: base, valid: true },
    { name: 'minimal event', value: minimalEvent(), valid: true },
    ...AUDIT_ACTIONS.map((action) => ({
      name: `action ${action}`,
      value: { ...base, action, severity: 'critical' },
      valid: true,
    })),
    { name: 'unknown action', value: { ...base, action: 'auth.impersonate' }, valid: false },
    { name: 'missing tenantId', value: without('tenantId'), valid: false },
    { name: 'missing hash', value: without('hash'), valid: false },
    { name: 'missing metadata', value: without('metadata'), valid: false },
    {
      name: 'uppercase tenantId',
      value: { ...base, tenantId: '01900000-0000-7000-8000-00000000000A' },
      valid: false,
    },
    { name: 'v4 id', value: { ...base, id: '01900000-0000-4000-8000-000000000001' }, valid: false },
    { name: 'extra key', value: { ...base, extra: true }, valid: false },
    {
      name: 'offset timestamp',
      value: { ...base, occurredAt: '2026-01-01T00:00:00.000+00:00' },
      valid: false,
    },
    {
      name: 'seconds timestamp',
      value: { ...base, occurredAt: '2026-01-01T00:00:00Z' },
      valid: false,
    },
    { name: 'seq 0', value: { ...base, seq: 0 }, valid: false },
    { name: 'fractional seq', value: { ...base, seq: 2.5 }, valid: false },
    { name: 'unsafe seq', value: { ...base, seq: 2 ** 53 }, valid: false },
    { name: 'string seq', value: { ...base, seq: '1' }, valid: false },
    { name: 'short hash', value: { ...base, hash: 'abc' }, valid: false },
    {
      name: 'genesis prevHash',
      value: { ...base, prevHash: AUDIT_GENESIS_PREV_HASH },
      valid: true,
    },
    { name: 'unknown outcome', value: { ...base, outcome: 'maybe' }, valid: false },
    { name: 'unknown severity', value: { ...base, severity: 'debug' }, valid: false },
    {
      name: 'operator actor',
      value: { ...base, actor: { type: 'operator', id: 'op' } },
      valid: true,
    },
    { name: 'anonymous actor', value: { ...base, actor: { type: 'anonymous' } }, valid: true },
    {
      name: 'anonymous with id',
      value: { ...base, actor: { type: 'anonymous', id: 'x' } },
      valid: false,
    },
    { name: 'user without id', value: { ...base, actor: { type: 'user' } }, valid: false },
    {
      name: 'service with email',
      value: { ...base, actor: { type: 'service', id: 's', email: 'a@b.test' } },
      valid: false,
    },
    {
      name: 'bad actor email',
      value: { ...base, actor: { type: 'user', id: 'u', email: 'nope' } },
      valid: false,
    },
    {
      name: 'unknown actor type',
      value: { ...base, actor: { type: 'robot', id: 'r' } },
      valid: false,
    },
    {
      name: 'unknown target type',
      value: { ...base, target: { type: 'galaxy', id: 'g' } },
      valid: false,
    },
    {
      name: 'bad publicId',
      value: { ...base, target: { type: 'run', id: 'r', publicId: 'run-1' } },
      valid: false,
    },
    { name: 'ipv6', value: { ...base, ip: '2001:db8::1' }, valid: true },
    { name: 'bad ip', value: { ...base, ip: '300.1.1.1' }, valid: false },
    { name: 'zero traceId', value: { ...base, traceId: '0'.repeat(32) }, valid: false },
    { name: 'empty reason', value: { ...base, reason: '' }, valid: false },
    { name: 'null optional', value: { ...base, reason: null }, valid: false },
    { name: 'metadata array', value: { ...base, metadata: [] }, valid: false },
    {
      name: 'nested metadata',
      value: { ...base, metadata: { a: [1, { b: null }], c: 'x' } },
      valid: true,
    },
    {
      name: 'metadataRef',
      value: {
        ...base,
        metadataRef: { evidenceKey: 'k', sha256: 'c'.repeat(64), sizeBytes: 20_000 },
      },
      valid: true,
    },
    {
      name: 'small metadataRef',
      value: { ...base, metadataRef: { evidenceKey: 'k', sha256: 'c'.repeat(64), sizeBytes: 10 } },
      valid: false,
    },
  ];
}

describe('audit event JSON Schema artifact', () => {
  it('is committed and identical to the schema generated from Zod', () => {
    // Compared as JSON values, so formatting the committed file (Prettier) does not matter.
    const committedSchema = JSON.parse(
      committed(SCHEMA_FILE, serialise(auditEventJsonSchema())),
    ) as unknown;
    expect(committedSchema).toEqual(auditEventJsonSchema());
  });

  it('validates the same fixtures as the Zod schema', () => {
    for (const fixture of fixtures()) {
      expect(zodAccepts(fixture.value), `zod: ${fixture.name}`).toBe(fixture.valid);
      expect(jsonSchemaAccepts(fixture.value), `json schema: ${fixture.name}`).toBe(fixture.valid);
    }
  });

  it('agrees with Zod on arbitrary valid events and on single-field mutations (property)', () => {
    const fields = Object.keys(validEvent());
    fc.assert(
      fc.property(
        validEventArbitrary,
        fc.constantFrom(...fields),
        fc.oneof(fc.constant(undefined), fc.jsonValue({ maxDepth: 2 })),
        (event, field, replacement) => {
          expect(jsonSchemaAccepts(event)).toBe(true);
          expect(zodAccepts(event)).toBe(true);
          const mutated: Record<string, unknown> = { ...event };
          if (replacement === undefined) {
            Reflect.deleteProperty(mutated, field);
          } else {
            mutated[field] = replacement;
          }
          expect(jsonSchemaAccepts(mutated)).toBe(zodAccepts(mutated));
        },
      ),
    );
  });
});

interface HashVector {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly canonical: string;
  readonly sha256: string;
}

function generateVectors(): HashVector[] {
  const nfd = 'Amélie — 😀';
  const inputs: { name: string; input: Record<string, unknown> }[] = [
    { name: 'genesis event, every optional field', input: validEvent() },
    { name: 'required fields only', input: minimalEvent() },
    {
      name: 'NFD strings are hashed as NFC; non-ASCII is not escaped',
      input: {
        ...minimalEvent(),
        action: 'config.changed',
        severity: 'notice',
        reason: nfd,
        metadata: { [nfd]: nfd },
      },
    },
    {
      name: 'numbers, nesting and key order',
      input: {
        ...minimalEvent(),
        action: 'tool.invoked',
        severity: 'info',
        metadata: {
          z: [3, -0.5, 1e21, 0],
          a: { y: true, b: null, é: 'e-acute', B: 'upper' },
          m: 12.25,
        },
        seq: Number.MAX_SAFE_INTEGER,
      },
    },
    {
      name: 'control characters and escapes',
      input: {
        ...minimalEvent(),
        action: 'egress.blocked',
        severity: 'warning',
        reason: 'tab\there "quoted" \\ \u0007 /',
      },
    },
  ];
  return inputs.map(({ name, input }) => {
    const canonical = auditEventHashInput(AuditEventSchema.parse(input));
    return { name, input, canonical, sha256: sha256(canonical) };
  });
}

describe('cross-language hash vectors', () => {
  it('are committed and match the TypeScript canonicalisation and SHA-256', () => {
    const generated = generateVectors();
    const file = JSON.parse(
      committed(
        VECTORS_FILE,
        serialise({
          description:
            'AUDIT-001 shared vectors: canonical = JCS (RFC 8785) of the NFC-normalised event without "hash"; sha256 = hex SHA-256 of the UTF-8 canonical text.',
          vectors: generated,
        }),
      ),
    ) as { vectors: HashVector[] };
    expect(file.vectors).toEqual(generated);
    for (const vector of file.vectors) {
      expect(sha256(auditEventHashInput(AuditEventSchema.parse(vector.input))), vector.name).toBe(
        vector.sha256,
      );
    }
  });

  it('produce the same hash whatever the input key order', () => {
    for (const vector of generateVectors()) {
      const reversed = Object.fromEntries(Object.entries(vector.input).reverse());
      expect(sha256(auditEventHashInput(AuditEventSchema.parse(reversed)))).toBe(vector.sha256);
    }
  });
});
