import { createHash, createHmac } from 'node:crypto';

import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  type AuditActor,
  type AuditTarget,
  type CreateSecretRequest,
  createSecretRequestSchema,
  DEFAULT_PAGE_LIMIT,
  formatSecretRef,
  idempotencyKeySchema,
  MAX_PAGE_LIMIT,
  type Page,
  SECRET_VALUE_MAX_BYTES,
  type SecretMetadata as SecretMetadataView,
  secretMetadataSchema,
  type SecretWriteResponse,
  updateSecretRequestSchema,
  uuidV7Schema,
} from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  isAppError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { SECRET_VALUE_PURPOSE, type EnvelopeCrypto } from '@blackwing/secrets';
import { type Clock, systemClock } from '@blackwing/time';

import { SecretApiError } from './errors.js';
import {
  SECRET_READ_META_ACTION,
  SECRET_WRITE_ACTION,
  type SecretPolicyEngine,
  type SecretPolicyResource,
} from './policy.js';
import { versionEtag } from '../concurrency/etag.js';
import { requireIfMatch } from '../concurrency/if-match.js';

import type { SecretMetrics, SecretWriteOp, SecretWriteResult } from './metrics.js';
import type {
  SecretAuditRecord,
  SecretAuditSink,
  SecretMetadata,
  SecretPrincipal,
  SecretStore,
  SecretUsageReader,
} from './ports.js';
import type { Logger } from '@blackwing/logger';
import type { z } from 'zod';

export const SECRET_WRITE_SPAN = 'secret.write';
const TRACER_NAME = '@blackwing/api/secrets';
/** The only backend writable through this API; BYOK backends need a locator flow (SECRETS-009+). */
const WRITABLE_BACKEND = 'openbao';

type Access = 'read' | 'write';

export interface SecretServiceDeps {
  readonly store: SecretStore;
  readonly usage: SecretUsageReader;
  /** Envelope encryption (SECRETS-002). An unreachable KEK fails the write closed (503). */
  readonly crypto: Pick<EnvelopeCrypto, 'encryptSecret'>;
  readonly audit: SecretAuditSink;
  readonly policy: SecretPolicyEngine;
  readonly logger: Logger;
  readonly metrics: SecretMetrics;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  readonly tracer?: Tracer;
}

/** Fields every operation carries from the HTTP layer. */
interface CallInput {
  readonly principal: SecretPrincipal;
  readonly traceId: string | null;
}

export interface CreateSecretInput extends CallInput {
  readonly body: unknown;
  /** Raw `Idempotency-Key` header, if any. */
  readonly idempotencyKey: string | undefined;
}

export interface UpdateSecretInput extends CallInput {
  readonly secretId: string;
  readonly body: unknown;
  /** Raw `If-Match` header, if any. Optional: without it the update is last-writer-wins. */
  readonly ifMatch: string | readonly string[] | undefined;
}

export interface DeleteSecretInput extends CallInput {
  readonly secretId: string;
  /** Disable even though other resources still reference the secret. */
  readonly force: boolean;
}

export interface ListSecretsInput extends CallInput {
  readonly query: Readonly<Record<string, unknown>>;
}

export interface WriteResult {
  readonly response: SecretWriteResponse;
  /** True when this request created the secret (false: idempotent replay). */
  readonly created: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The page parameters of `GET /v1/secrets`: a `limit` (clamped) and an opaque `cursor`. */
function parsePage(query: Readonly<Record<string, unknown>>): {
  readonly afterId?: string;
  readonly limit: number;
} {
  const { cursor, limit } = query;
  let size = DEFAULT_PAGE_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^\d{1,9}$/.test(limit) || Number(limit) < 1) {
      throw new ValidationError('invalid page query', {
        detail: 'limit must be a positive integer',
      });
    }
    size = Math.min(Number(limit), MAX_PAGE_LIMIT);
  }
  if (cursor === undefined) return { limit: size };
  if (!uuidV7Schema.safeParse(cursor).success) {
    throw new ValidationError('invalid page query', { detail: 'cursor is not valid' });
  }
  return { afterId: cursor as string, limit: size };
}

/** Body validation. Never echoes input: the error names fields, not values (the body holds a secret). */
function parseBody<S extends z.ZodType>(body: unknown, schema: S): z.output<S> {
  if (!isRecord(body)) throw new ValidationError('request body must be a JSON object');
  // Size first, so an oversized value is 413 SECRET_TOO_LARGE, not a generic validation error.
  const { value } = body;
  if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > SECRET_VALUE_MAX_BYTES) {
    throw new SecretApiError(
      'SECRET_TOO_LARGE',
      `a secret value is at most ${String(SECRET_VALUE_MAX_BYTES)} bytes`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(body)');
    throw new ValidationError('invalid secret request', {
      detail: `invalid fields: ${[...new Set(fields)].join(', ')}`,
    });
  }
  return parsed.data;
}

/** The view of a secret: explicit fields through the strict schema, so nothing else can ride along. */
function viewOf(secret: SecretMetadata): SecretMetadataView {
  return secretMetadataSchema.parse({
    secretId: secret.id,
    secretRef: formatSecretRef({ tenantId: secret.tenantId, secretId: secret.id }),
    name: secret.name,
    type: secret.type,
    purpose: secret.purpose,
    backend: secret.backend,
    status: secret.status,
    currentVersion: secret.currentVersion,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  });
}

function writeResponse(secret: SecretMetadata, version: number): SecretWriteResponse {
  return {
    secretId: secret.id,
    secretRef: formatSecretRef({ tenantId: secret.tenantId, secretId: secret.id }),
    version,
  };
}

/** The `secret_write_total` result label of a failure. */
function resultOf(err: unknown): SecretWriteResult {
  if (!isAppError(err)) return 'error';
  switch (err.code) {
    case 'FORBIDDEN':
      return 'denied';
    case 'NOT_FOUND':
      return 'not_found';
    case 'VALIDATION_FAILED':
    case 'SECRET_TOO_LARGE':
    case 'IDEMPOTENCY_KEY_REQUIRED':
    case 'IDEMPOTENCY_KEY_MISMATCH':
      return 'invalid';
    case 'SECRET_NAME_CONFLICT':
    case 'SECRET_IN_USE':
    case 'CONFLICT':
      return 'conflict';
    case 'PRECONDITION_FAILED':
    case 'PRECONDITION_REQUIRED':
      return 'stale';
    case 'KEK_UNAVAILABLE':
    case 'KEK_DISABLED':
      return 'unavailable';
    default:
      return 'error';
  }
}

function actorOf(principal: SecretPrincipal): AuditActor {
  const tokenId = principal.tokenId === undefined ? {} : { tokenId: principal.tokenId };
  return principal.type === 'user'
    ? { type: 'user', id: principal.id, ...tokenId }
    : { type: 'service', id: principal.id, ...tokenId };
}

/**
 * The write-only secrets API (SECRETS-004): validate, authorise (RBAC then Cedar), encrypt, persist with
 * the audit event, answer with metadata. The value exists only as the request string and as the argument
 * of `encryptSecret`: it is never stored, logged, audited, put in a span or returned (§8.7).
 */
export class SecretService {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly tracer: Tracer;

  constructor(private readonly deps: SecretServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.nextId = deps.idGenerator ?? newId;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  create(input: CreateSecretInput): Promise<WriteResult> {
    return this.write('create', input, async (tenantId) => {
      const secretId = this.nextId();
      await this.authorise(input, tenantId, 'write', { id: secretId, tenantId });
      const key = this.requireIdempotencyKey(input.idempotencyKey);
      const request = parseBody(input.body, createSecretRequestSchema);
      const backend = request.backend ?? WRITABLE_BACKEND;
      if (backend !== WRITABLE_BACKEND) {
        throw new ValidationError('unsupported backend', {
          detail: `only the ${WRITABLE_BACKEND} backend can be written through this API`,
        });
      }

      const keyHash = sha256Hex(key);
      const fingerprint = fingerprintOf(key, request, backend);
      const previous = await this.deps.store.findByIdempotencyKey(tenantId, keyHash);
      if (previous !== null) return this.replay(previous, fingerprint);

      const envelope = await this.deps.crypto.encryptSecret({
        tenantId,
        plaintext: request.value,
        context: { secretId, purpose: SECRET_VALUE_PURPOSE },
      });
      const now = this.clock.now().toISOString();
      const secret: SecretMetadata = {
        id: secretId,
        tenantId,
        name: request.name,
        type: request.type ?? null,
        purpose: request.purpose ?? null,
        backend,
        status: 'active',
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      const result = await this.deps.store.create({
        secret,
        envelope,
        idempotency: { keyHash, fingerprint },
        audit: this.record(input, tenantId, 'secret.created', secret, { version: 1, backend }),
      });
      if (result.kind === 'name_conflict') {
        throw new SecretApiError(
          'SECRET_NAME_CONFLICT',
          'a secret with this name already exists in the tenant',
        );
      }
      if (result.kind === 'idempotent_replay') return this.replay(result, fingerprint);
      this.logWrite('create', tenantId, secretId);
      return { response: writeResponse(secret, 1), created: true };
    });
  }

  update(input: UpdateSecretInput): Promise<{ readonly response: SecretWriteResponse }> {
    return this.write('update', input, async (tenantId) => {
      const current = await this.authoriseExisting(input, tenantId, 'write', input.secretId);
      if (current.status !== 'active') this.notActive(current.status);
      const request = parseBody(input.body, updateSecretRequestSchema);
      // Optional: without If-Match the update is last-writer-wins; with it, a stale ETag is 412.
      const match =
        input.ifMatch === undefined
          ? undefined
          : requireIfMatch(versionEtag(current.currentVersion), input.ifMatch);

      const envelope = await this.deps.crypto.encryptSecret({
        tenantId,
        plaintext: request.value,
        context: { secretId: current.id, purpose: SECRET_VALUE_PURPOSE },
      });
      const result = await this.deps.store.addVersion({
        tenantId,
        secretId: current.id,
        envelope,
        ...(match?.expectedVersion === undefined ? {} : { expectedVersion: match.expectedVersion }),
        now: this.clock.now().toISOString(),
        audit: (after) =>
          this.record(input, tenantId, 'secret.updated', after, { version: after.currentVersion }),
      });
      switch (result.kind) {
        case 'not_found':
          throw new NotFoundError('secret not found');
        case 'stale':
          throw new PreconditionFailedError('secret was modified concurrently', {
            detail: 'The secret was modified; re-fetch it and retry.',
          });
        case 'inactive':
          return this.notActive(result.status);
        case 'updated':
          this.logWrite('update', tenantId, current.id);
          return { response: writeResponse(result.secret, result.secret.currentVersion) };
      }
    });
  }

  delete(input: DeleteSecretInput): Promise<SecretMetadataView> {
    return this.write('delete', input, async (tenantId) => {
      const current = await this.authoriseExisting(input, tenantId, 'write', input.secretId);
      // Already disabled (or shredded): nothing to change and nothing to audit; DELETE stays idempotent.
      if (current.status === 'disabled' || current.status === 'shredded') return viewOf(current);
      const referencedBy = await this.deps.usage.referencingTypes(tenantId, current.id);
      if (referencedBy.length > 0 && !input.force) {
        throw new SecretApiError(
          'SECRET_IN_USE',
          `the secret is referenced by: ${referencedBy.join(', ')}; disabling it breaks them. Retry with force=true to disable it anyway`,
        );
      }
      const result = await this.deps.store.disable({
        tenantId,
        secretId: current.id,
        now: this.clock.now().toISOString(),
        audit: (after) =>
          this.record(input, tenantId, 'secret.deleted', after, {
            forced: referencedBy.length > 0,
            referencedBy: referencedBy.join(','),
          }),
      });
      if (result.kind === 'not_found') throw new NotFoundError('secret not found');
      if (result.kind === 'disabled') this.logWrite('delete', tenantId, current.id);
      return viewOf(result.secret);
    });
  }

  async get(input: CallInput & { readonly secretId: string }): Promise<SecretMetadataView> {
    const tenantId = this.requireTenant(input.principal);
    const secret = await this.authoriseExisting(input, tenantId, 'read', input.secretId);
    return viewOf(secret);
  }

  async list(input: ListSecretsInput): Promise<Page<SecretMetadataView>> {
    const tenantId = this.requireTenant(input.principal);
    // The collection is authorised as the tenant's own `Secret`: one resource per tenant.
    await this.authorise(input, tenantId, 'read', { id: tenantId, tenantId });
    const page = parsePage(input.query);
    const rows = await this.deps.store.list(tenantId, {
      ...(page.afterId === undefined ? {} : { afterId: page.afterId }),
      limit: page.limit + 1,
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    const hasMore = rows.length > page.limit;
    return {
      items: items.map((row) => viewOf(row)),
      nextCursor: hasMore && last !== undefined ? last.id : null,
      hasMore,
    };
  }

  /** Span, metrics and the tenant check around one write operation. */
  private write<T>(
    op: SecretWriteOp,
    input: CallInput,
    run: (tenantId: string) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(SECRET_WRITE_SPAN, async (span: Span) => {
      span.setAttribute('bw.secret.op', op);
      try {
        const tenantId = this.requireTenant(input.principal);
        span.setAttribute('bw.tenant_id', tenantId);
        const result = await run(tenantId);
        this.deps.metrics.writes.inc({ op, result: 'success' });
        return result;
      } catch (err) {
        this.deps.metrics.writes.inc({ op, result: resultOf(err) });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private requireTenant(principal: SecretPrincipal): string {
    if (principal.tenantId === null || principal.tenantId.length === 0) {
      throw new AuthError('no tenant context on the authenticated principal', {
        detail: 'a tenant context is required',
      });
    }
    return principal.tenantId;
  }

  private requireIdempotencyKey(raw: string | undefined): string {
    if (raw === undefined || raw.length === 0) {
      throw new SecretApiError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'POST /v1/secrets requires an Idempotency-Key header',
      );
    }
    if (!idempotencyKeySchema.safeParse(raw).success) {
      throw new SecretApiError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key must be 8 to 255 visible ASCII characters',
      );
    }
    return raw;
  }

  private replay(
    previous: { readonly secret: SecretMetadata; readonly fingerprint: string },
    fingerprint: string,
  ): WriteResult {
    if (previous.fingerprint !== fingerprint) {
      throw new SecretApiError(
        'IDEMPOTENCY_KEY_MISMATCH',
        'this Idempotency-Key was already used with a different secret request',
      );
    }
    // The first answer was version 1, whatever the secret has become since.
    return { response: writeResponse(previous.secret, 1), created: false };
  }

  private notActive(status: string): never {
    throw new ConflictError('secret is not active', {
      detail: `the secret is ${status}; only an active secret can be changed`,
    });
  }

  /** RBAC permission, then the Cedar check, for a resource that does not exist yet or a collection. */
  private async authorise(
    input: CallInput,
    tenantId: string,
    access: Access,
    resource: SecretPolicyResource,
  ): Promise<void> {
    const target: AuditTarget = { type: 'tenant', id: tenantId };
    await this.requirePermission(input, tenantId, access, target);
    await this.requireResource(input, tenantId, access, resource, target);
  }

  /**
   * The same two checks for an existing secret. The tenant-scoped store resolves it between them, so
   * another tenant's id and a missing one are the same 404 (no existence oracle, §8.6).
   */
  private async authoriseExisting(
    input: CallInput,
    tenantId: string,
    access: Access,
    secretId: string,
  ): Promise<SecretMetadata> {
    await this.requirePermission(input, tenantId, access, { type: 'tenant', id: tenantId });
    const secret = await this.existing(tenantId, secretId);
    await this.requireResource(
      input,
      tenantId,
      access,
      { id: secret.id, tenantId: secret.tenantId },
      { type: 'secret_ref', id: secret.id },
    );
    return secret;
  }

  private async requirePermission(
    input: CallInput,
    tenantId: string,
    access: Access,
    target: AuditTarget,
  ): Promise<void> {
    if (
      !hasPermission(input.principal.roles, access === 'write' ? 'secret:write' : 'secret:read')
    ) {
      await this.refuse(input, tenantId, access, 'rbac', target, 0);
    }
  }

  private async requireResource(
    input: CallInput,
    tenantId: string,
    access: Access,
    resource: SecretPolicyResource,
    target: AuditTarget,
  ): Promise<void> {
    const { principal } = input;
    const decision = this.deps.policy.authorize(
      { userId: principal.id, tenantId, roles: principal.roles },
      access === 'write' ? SECRET_WRITE_ACTION : SECRET_READ_META_ACTION,
      resource,
    );
    if (decision.decision !== 'allow') {
      await this.refuse(input, tenantId, access, 'cedar', target, decision.errors.length);
    }
  }

  private async refuse(
    input: CallInput,
    tenantId: string,
    access: Access,
    check: 'rbac' | 'cedar',
    target: AuditTarget,
    policyErrors: number,
  ): Promise<never> {
    const { principal } = input;
    await this.appendDenied({
      action: 'authz.denied',
      severity: 'warning',
      outcome: 'denied',
      tenantId,
      actor: actorOf(principal),
      target,
      occurredAt: this.clock.now().toISOString(),
      traceId: input.traceId,
      metadata: { check, access, policyErrors },
    });
    this.deps.logger.warn({ tenantId, actorRef: principal.id, access, check }, 'secret refused');
    throw new ForbiddenError('not permitted', {
      detail: 'you are not permitted to access secrets in this way',
    });
  }

  private async existing(tenantId: string, secretId: string): Promise<SecretMetadata> {
    const secret = uuidV7Schema.safeParse(secretId).success
      ? await this.deps.store.get(tenantId, secretId)
      : null;
    // The store is tenant-scoped; the extra check keeps a faulty adapter from leaking a foreign row.
    if (secret?.tenantId !== tenantId) throw new NotFoundError('secret not found');
    return secret;
  }

  private record(
    input: CallInput,
    tenantId: string,
    action: 'secret.created' | 'secret.updated' | 'secret.deleted',
    secret: SecretMetadata,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): SecretAuditRecord {
    return {
      action,
      severity: 'notice',
      outcome: 'success',
      tenantId,
      actor: actorOf(input.principal),
      target: { type: 'secret_ref', id: secret.id },
      occurredAt: this.clock.now().toISOString(),
      traceId: input.traceId,
      metadata: { secretId: secret.id, ...metadata },
    };
  }

  private logWrite(op: SecretWriteOp, tenantId: string, secretId: string): void {
    this.deps.logger.info({ tenantId, secretId, op }, 'secret written');
  }

  /** A denial is audited best-effort: a failed append never turns the refusal into an allow. */
  private async appendDenied(record: SecretAuditRecord): Promise<void> {
    try {
      await this.deps.audit.append(record);
    } catch (err) {
      this.deps.metrics.auditFailures.inc({ action: record.action });
      this.deps.logger.error({ action: record.action, err }, 'secret audit append failed');
    }
  }
}

/**
 * Detects an `Idempotency-Key` reused with another request. The value is part of the request, so the
 * fingerprint is an HMAC keyed by the raw key, which the store never sees (it holds `sha256(key)`): a
 * database leak yields nothing to brute-force a weak password against.
 */
function fingerprintOf(key: string, request: CreateSecretRequest, backend: string): string {
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        request.name,
        request.type ?? null,
        request.purpose ?? null,
        backend,
        request.value,
      ]),
      'utf8',
    )
    .digest('hex');
}
