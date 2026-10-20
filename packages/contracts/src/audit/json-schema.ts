import { z } from 'zod';

import { AUDIT_METADATA_MAX_BYTES, auditEventShapeSchema } from './event.js';

/** `$id` of the published audit event JSON Schema. */
export const AUDIT_EVENT_JSON_SCHEMA_ID = 'urn:blackwing:contracts:audit-event:v1';

/**
 * The audit event as a JSON Schema (draft 2020-12), for producers that cannot run Zod: the Go egress
 * gateway validates against the committed copy, `packages/contracts/schemas/audit-event.schema.json`.
 * A test keeps that file identical to this output.
 *
 * JSON Schema cannot express NFC normalisation, the metadata byte cap or the severity floor; the
 * schema's description lists them and every producer applies them before hashing.
 */
export function auditEventJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(auditEventShapeSchema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  });
  return {
    ...generated,
    $id: AUDIT_EVENT_JSON_SCHEMA_ID,
    title: 'Blackwing audit event',
    description: [
      'Canonical audit ledger event (AUDIT-001). Rules outside JSON Schema that every producer applies:',
      'strings are NFC-normalised;',
      `canonical (RFC 8785) metadata is at most ${String(AUDIT_METADATA_MAX_BYTES)} UTF-8 bytes, larger metadata goes to the evidence store via metadataRef;`,
      'severity is never below the action catalogue default;',
      'metadata is redacted by the producer;',
      'hash = sha256(JCS(event without hash)).',
    ].join(' '),
  };
}
