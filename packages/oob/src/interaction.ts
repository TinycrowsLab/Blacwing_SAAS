import { z } from 'zod';

import { AppError } from '@blackwing/errors';

import { CORRELATION_ID_LENGTH } from './protocol.js';

/** Protocols the listener reports. interactsh reports HTTPS interactions as `http`; `https` is accepted for forward compatibility. */
export const OOB_PROTOCOLS = ['dns', 'http', 'https', 'smtp', 'ldap'] as const;
export type OobProtocol = (typeof OOB_PROTOCOLS)[number];

/** Longest remote address kept (an IP and port, or a DNS resolver's). */
const MAX_REMOTE_ADDRESS_LENGTH = 256;

/** A correlation id as the client mints it (see `newCorrelationId`). */
const CORRELATION_ID = new RegExp(`^[a-z2-7]{${CORRELATION_ID_LENGTH}}$`);
/** A full interaction id: the correlation id followed by the per-test nonce, DNS label characters only. */
const FULL_ID = /^[a-z0-9]{20,128}$/;

/**
 * One decrypted interaction, as the polling worker consumes it. The raw bytes are base64 so that binary or
 * non-UTF-8 request and response data round-trips without loss. `timestamp` is the listener's clock and
 * `receivedAt` is this client's clock: the two are recorded separately, never merged (clock skew).
 */
export const oobInteractionSchema = z.object({
  protocol: z.enum(OOB_PROTOCOLS),
  correlationId: z.string().regex(CORRELATION_ID),
  fullId: z.string().regex(FULL_ID),
  remoteAddress: z.string().max(MAX_REMOTE_ADDRESS_LENGTH),
  timestamp: z.date(),
  receivedAt: z.date(),
  rawRequest: z.string(),
  rawResponse: z.string().optional(),
});
export type OobInteraction = z.infer<typeof oobInteractionSchema>;

/**
 * One record as the listener serialises it inside an encrypted batch (JSON, kebab-case keys). Unknown keys
 * are ignored, so an additive field in a newer server does not break decoding; the pinned version gates the rest.
 */
export const wireInteractionSchema = z.object({
  protocol: z.enum(OOB_PROTOCOLS),
  'unique-id': z.string(),
  'full-id': z.string(),
  'remote-address': z.string().optional(),
  timestamp: z.string(),
  'raw-request': z.string().optional(),
  'raw-response': z.string().optional(),
});
export type WireInteraction = z.infer<typeof wireInteractionSchema>;

/**
 * Maps one decrypted record to an {@link OobInteraction}. A record whose id is not under this client's
 * correlation id is refused, never returned: it would correlate another session's traffic to this run.
 */
export function toInteraction(
  wire: WireInteraction,
  correlationId: string,
  receivedAt: Date,
): OobInteraction {
  if (!wire['unique-id'].startsWith(correlationId) || !wire['full-id'].startsWith(correlationId)) {
    throw new AppError('OOB_PROTOCOL_INCOMPATIBLE', 'out-of-band record is not correlated', {
      detail: 'a record does not carry this client correlation id',
    });
  }
  const timestamp = new Date(wire.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new AppError('OOB_PROTOCOL_INCOMPATIBLE', 'out-of-band record has no valid timestamp', {
      detail: 'the listener timestamp is not RFC 3339',
    });
  }
  const parsed = oobInteractionSchema.safeParse({
    protocol: wire.protocol,
    correlationId,
    fullId: wire['full-id'],
    remoteAddress: wire['remote-address'] ?? '',
    timestamp,
    receivedAt,
    rawRequest: Buffer.from(wire['raw-request'] ?? '', 'utf8').toString('base64'),
    ...(wire['raw-response'] === undefined
      ? {}
      : { rawResponse: Buffer.from(wire['raw-response'], 'utf8').toString('base64') }),
  });
  if (!parsed.success) {
    throw new AppError('OOB_PROTOCOL_INCOMPATIBLE', 'out-of-band record failed validation', {
      detail: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
    });
  }
  return parsed.data;
}
