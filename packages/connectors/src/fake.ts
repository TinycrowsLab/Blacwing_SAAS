import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  ConnectorAuthFailedError,
  ConnectorNotFoundError,
  ConnectorValidationError,
} from './errors.js';
import {
  type ConnectionTestResult,
  type ResolvedConnectorConfig,
  type TicketConnector,
  type TicketPatch,
  type TicketPayload,
  type TicketRef,
  type TicketStatus,
  type WebhookEvent,
  type WebhookHeaders,
  ticketPatchSchema,
  ticketPayloadSchema,
  ticketStatusSchema,
} from './types.js';

/** The provider name the fake registers under. */
export const FAKE_PROVIDER = 'fake';

/** Header a test webhook must carry: it must equal the resolved credential. */
export const FAKE_WEBHOOK_SIGNATURE_HEADER = 'x-fake-signature';

/** The only webhook payload type the fake treats as relevant. Anything else is irrelevant and yields `null`. */
const FAKE_STATUS_WEBHOOK_TYPE = 'ticket.status_changed';

const EXTERNAL_ID_MAX = 128;

const statusWebhookSchema = z.strictObject({
  type: z.literal(FAKE_STATUS_WEBHOOK_TYPE),
  externalId: z.string().min(1).max(EXTERNAL_ID_MAX),
  status: ticketStatusSchema,
});

const jsonObjectSchema = z.looseObject({ type: z.unknown() });

interface StoredTicket {
  readonly projectKeyOrRepo: string;
  readonly url: string;
  payload: TicketPayload;
  status: TicketStatus;
}

/**
 * In-memory connector for unit tests of the push worker and sync. It implements the full contract without network IO:
 * create, get, update, test and webhook verification. Its webhook check is fail-closed: a missing or wrong signature
 * is `CONNECTOR_AUTH_FAILED` and no event is produced. Every method rejects (never throws synchronously), as the
 * contract is asynchronous.
 */
export class FakeConnector implements TicketConnector {
  private readonly tickets = new Map<string, StoredTicket>();
  private nextId = 1;

  testConnection(cfg: ResolvedConnectorConfig): Promise<ConnectionTestResult> {
    return settle(() => {
      requireCredential(cfg);
      return { ok: true, accountLabel: 'fake' };
    });
  }

  createTicket(cfg: ResolvedConnectorConfig, payload: TicketPayload): Promise<TicketRef> {
    return settle(() => {
      requireCredential(cfg);
      const parsed = parseWith(ticketPayloadSchema, payload, 'Ticket payload failed validation');
      const externalId = `FAKE-${this.nextId}`;
      this.nextId += 1;
      const projectKeyOrRepo = projectOf(cfg);
      const url = `https://fake.invalid/tickets/${externalId}`;
      this.tickets.set(externalId, { projectKeyOrRepo, url, payload: parsed, status: 'open' });
      return { provider: FAKE_PROVIDER, externalId, url, projectKeyOrRepo };
    });
  }

  updateTicket(cfg: ResolvedConnectorConfig, ref: TicketRef, patch: TicketPatch): Promise<void> {
    return settle(() => {
      requireCredential(cfg);
      const stored = this.lookup(ref);
      const parsedPatch = parseWith(ticketPatchSchema, patch, 'Ticket patch failed validation');
      // Re-validate the merged content, so a patch can never leave the stored ticket in a shape createTicket refuses.
      stored.payload = parseWith(
        ticketPayloadSchema,
        { ...stored.payload, ...parsedPatch },
        'Ticket patch failed validation',
      );
    });
  }

  getTicket(
    cfg: ResolvedConnectorConfig,
    ref: TicketRef,
  ): Promise<{ readonly status: TicketStatus; readonly url: string }> {
    return settle(() => {
      requireCredential(cfg);
      const stored = this.lookup(ref);
      return { status: stored.status, url: stored.url };
    });
  }

  verifyWebhook(
    cfg: ResolvedConnectorConfig,
    headers: WebhookHeaders,
    rawBody: string,
  ): Promise<WebhookEvent | null> {
    return settle(() => {
      requireCredential(cfg);
      const signature = headers[FAKE_WEBHOOK_SIGNATURE_HEADER];
      if (signature === undefined || !constantTimeEqual(signature, cfg.credential))
        throw new ConnectorAuthFailedError('Webhook signature did not verify');
      const body = parseJson(rawBody);
      if (body.type !== FAKE_STATUS_WEBHOOK_TYPE) return null;
      const parsed = statusWebhookSchema.safeParse(body);
      if (!parsed.success)
        throw new ConnectorValidationError('Webhook status payload is malformed');
      return {
        kind: 'ticket.status_changed',
        provider: FAKE_PROVIDER,
        externalId: parsed.data.externalId,
        status: parsed.data.status,
      };
    });
  }

  /** Test helper: moves a stored ticket to `status`, as an upstream user would. */
  setStatus(externalId: string, status: TicketStatus): void {
    const stored = this.tickets.get(externalId);
    if (stored === undefined) throw new ConnectorNotFoundError('Ticket not found in connector');
    stored.status = status;
  }

  /** A ref for another provider, another project or an unknown id is "not found", never a leak of other tickets. */
  private lookup(ref: TicketRef): StoredTicket {
    const stored = ref.provider === FAKE_PROVIDER ? this.tickets.get(ref.externalId) : undefined;
    if (stored?.projectKeyOrRepo !== ref.projectKeyOrRepo)
      throw new ConnectorNotFoundError('Ticket not found in connector');
    return stored;
  }
}

/**
 * Runs `operation` and reports its outcome as a promise. A synchronous throw inside the executor becomes a rejection,
 * so every connector method fails the same way whether the failure is found early or late.
 */
function settle<T>(operation: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(operation());
  });
}

function requireCredential(cfg: ResolvedConnectorConfig): void {
  if (cfg.credential.length === 0)
    throw new ConnectorAuthFailedError('Connector credential is empty');
}

function projectOf(cfg: ResolvedConnectorConfig): string {
  return cfg.settings.project ?? 'default';
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConnectorValidationError(message);
  return parsed.data;
}

function parseJson(rawBody: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new ConnectorValidationError('Webhook body is not valid JSON');
  }
  const parsed = jsonObjectSchema.safeParse(decoded);
  if (!parsed.success) throw new ConnectorValidationError('Webhook body is not a JSON object');
  return parsed.data;
}

function constantTimeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
