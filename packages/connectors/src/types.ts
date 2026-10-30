import { z } from 'zod';

import { cvssSeverityBandSchema } from '@blackwing/contracts';

/**
 * Normalised ticket status every provider maps its own states onto (sync, CONNECT-008, depends on this set).
 * `unknown` is the answer for a provider state with no safe mapping.
 */
export const ticketStatusSchema = z.enum([
  'open',
  'in_progress',
  'resolved',
  'closed',
  'reopened',
  'unknown',
]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

/** Bounds on ticket content. Connectors reject anything beyond them before an upstream call. */
export const TICKET_LIMITS = Object.freeze({
  titleMax: 255,
  bodyMarkdownMax: 65_536,
  labelsMax: 50,
  labelMax: 64,
  fieldsMax: 50,
  fieldValueMax: 1_024,
});

/** Provider-neutral ticket content, as the push worker builds it from a finding. */
export const ticketPayloadSchema = z.strictObject({
  title: z.string().trim().min(1).max(TICKET_LIMITS.titleMax),
  bodyMarkdown: z.string().max(TICKET_LIMITS.bodyMarkdownMax),
  severity: cvssSeverityBandSchema,
  labels: z
    .array(z.string().trim().min(1).max(TICKET_LIMITS.labelMax))
    .max(TICKET_LIMITS.labelsMax),
  priority: z.string().trim().min(1).max(TICKET_LIMITS.labelMax).optional(),
  fields: z
    .record(
      z.string().min(1).max(TICKET_LIMITS.labelMax),
      z.string().max(TICKET_LIMITS.fieldValueMax),
    )
    .refine((fields) => Object.keys(fields).length <= TICKET_LIMITS.fieldsMax, {
      message: 'too many fields',
    })
    .optional(),
});
export type TicketPayload = z.infer<typeof ticketPayloadSchema>;

/** A partial update of a ticket. Same bounds as {@link TicketPayload}; at least one field must be present. */
export const ticketPatchSchema = ticketPayloadSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'patch must change at least one field',
  });
export type TicketPatch = z.infer<typeof ticketPatchSchema>;

/**
 * Normalised reference to a ticket on any provider. Returned by `createTicket` as soon as the upstream has the ticket,
 * so a later failure (for example a truncated body) can still be repaired by a patch against this ref.
 */
export interface TicketRef {
  readonly provider: string;
  readonly externalId: string;
  readonly url: string;
  readonly projectKeyOrRepo: string;
}

/**
 * Connection settings resolved at call time (SECRETS, §8.7). `credential` is the plaintext secret: it lives in
 * memory for one call and is never stored, logged or included in an error message.
 */
export interface ResolvedConnectorConfig {
  readonly provider: string;
  readonly credential: string;
  readonly settings: Readonly<Record<string, string>>;
}

/** Outcome of `testConnection`. */
export interface ConnectionTestResult {
  readonly ok: true;
  readonly accountLabel?: string;
}

/** An inbound webhook that changes a ticket we track. Irrelevant deliveries are not events (`null`). */
export interface WebhookEvent {
  readonly kind: 'ticket.status_changed';
  readonly provider: string;
  readonly externalId: string;
  readonly status: TicketStatus;
}

/** Inbound webhook headers, already lowercased by the HTTP layer. */
export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

/**
 * The provider-agnostic contract every ticket connector implements. Concrete connectors (Jira, GitHub, GitLab)
 * keep all REST specifics inside themselves. Methods take the resolved config per call and never read secrets from
 * storage.
 */
export interface TicketConnector {
  testConnection(cfg: ResolvedConnectorConfig): Promise<ConnectionTestResult>;
  createTicket(cfg: ResolvedConnectorConfig, payload: TicketPayload): Promise<TicketRef>;
  updateTicket(cfg: ResolvedConnectorConfig, ref: TicketRef, patch: TicketPatch): Promise<void>;
  getTicket(
    cfg: ResolvedConnectorConfig,
    ref: TicketRef,
  ): Promise<{ readonly status: TicketStatus; readonly url: string }>;
  verifyWebhook(
    cfg: ResolvedConnectorConfig,
    headers: WebhookHeaders,
    rawBody: string,
  ): Promise<WebhookEvent | null>;
}
