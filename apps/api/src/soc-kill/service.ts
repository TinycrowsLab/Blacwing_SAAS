import { createHash, timingSafeEqual } from 'node:crypto';

import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import {
  type KillTriggerResponse,
  LIMITS,
  socKillTokenScopeSchema,
  uuidV7Schema,
} from '@blackwing/contracts';
import { type JwsKeyResolver, type JwsSigner, signJws, verifyJws } from '@blackwing/crypto';
import { hasPermission } from '@blackwing/domain';
import { AuthError, NotFoundError, RateLimitedError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type Clock, systemClock } from '@blackwing/time';

import { KillApiError } from '../kill/errors.js';

import type { SocKillMetrics } from './metrics.js';
import type {
  RateLimiter,
  SocKillAuditSink,
  SocKillContext,
  SocKillTokenRecord,
  SocKillTokenStore,
} from './ports.js';
import type { KillPolicyEngine, KillPolicyResource } from '../kill/policy.js';
import type { KillPrincipal, KillResourceReader } from '../kill/ports.js';
import type { KillService } from '../kill/service.js';
import type { Logger } from '@blackwing/logger';

export const SOC_KILL_VERIFY_SPAN = 'soc_kill.verify';
const TRACER_NAME = '@blackwing/api/soc-kill';

const MS_PER_SECOND = 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Clock skew allowed on `exp` and `expires_at`, both ways (documented: +/- 60 s). */
export const SOC_KILL_LEEWAY_MS = 60_000;
/** A link is never valid for longer than this, whatever the test window says. */
export const SOC_KILL_MAX_VALIDITY_MS = 30 * DAY_MS;
/** Per-IP and per-token limits per minute (KILL-007 requirement 4). */
const VERIFY_PER_IP = 10;
const VERIFY_PER_TOKEN = 30;
const TRIGGER_PER_TOKEN = 5;
export const SOC_KILL_LIMITS = Object.freeze({
  verifyPerIp: VERIFY_PER_IP,
  triggerPerIp: VERIFY_PER_IP,
  verifyPerToken: VERIFY_PER_TOKEN,
  triggerPerToken: TRIGGER_PER_TOKEN,
});
const DEFAULT_ASSET_MAX_USES = 3;
const DEFAULT_RUN_MAX_USES = 1;

/** A link stops one asset or one run; a whole-tenant kill is console-only (it is not a SOC power). */
const linkScopeSchema = socKillTokenScopeSchema.exclude(['tenant']);
type SocKillTokenScope = z.infer<typeof linkScopeSchema>;

/** The signed claims of a kill link (JWS payload). */
const claimsSchema = z.strictObject({
  tenantId: uuidV7Schema,
  scope: linkScopeSchema,
  scopeRefId: uuidV7Schema,
  jti: uuidV7Schema,
  /** Epoch seconds. */
  exp: z.int().positive(),
});
type Claims = z.infer<typeof claimsSchema>;

/** Why a link was refused. Internal only: every one is answered with the same generic 404. */
export type SocKillRejectReason =
  'invalid_signature' | 'unknown_token' | 'expired' | 'revoked' | 'used' | 'tenant_suspended';

type Operation = 'verify' | 'trigger';

export interface SocKillServiceDeps {
  readonly store: SocKillTokenStore;
  readonly context: SocKillContext;
  readonly kill: Pick<KillService, 'triggerFromSocLink'>;
  readonly resources: KillResourceReader;
  readonly policy: KillPolicyEngine;
  readonly audit: SocKillAuditSink;
  readonly limiter: RateLimiter;
  /** The platform signing key (current). */
  readonly signer: JwsSigner;
  /** Resolves the current AND previous `kid` so a rotation does not strand live links. */
  readonly resolveKey: JwsKeyResolver;
  /** Origin of the console, e.g. `https://app.blackwing.example`; the link is `<origin>/soc/kill/<token>`. */
  readonly linkOrigin: string;
  readonly logger: Logger;
  readonly metrics: SocKillMetrics;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  readonly tracer?: Tracer;
}

export interface SocKillMintInput {
  readonly principal: KillPrincipal;
  readonly scope: SocKillTokenScope;
  readonly scopeRefId: string;
  readonly contactId?: string;
  readonly maxUses?: number;
  /** Required for `run` links; for `asset` links it defaults to the end of the open test window. */
  readonly expiresAt?: Date;
  readonly traceId: string | null;
}

export interface SocKillMinted {
  readonly linkId: string;
  readonly scope: SocKillTokenScope;
  /** The only place the raw token ever appears. Not stored and not logged. */
  readonly url: string;
  readonly expiresAt: string;
  readonly maxUses: number;
}

export interface SocKillPreview {
  readonly scope: SocKillTokenScope;
  /** The asset label; the only tenant data the public page shows. */
  readonly label: string;
}

interface Verified {
  readonly claims: Claims;
  readonly record: SocKillTokenRecord;
}

const sha256 = (raw: string): Buffer => createHash('sha256').update(raw, 'utf8').digest();

/**
 * The login-free SOC kill link (KILL-007, F33, §8.5): mint, preview and trigger. The raw token is the
 * credential, so it is never logged, stored or put in an audit event; the stored row holds only its
 * SHA-256. Every refusal on the public path is the same generic 404, whatever the reason.
 */
export class SocKillService {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly tracer: Tracer;

  constructor(private readonly deps: SocKillServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.nextId = deps.idGenerator ?? newId;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  /** Mints a link for an asset or run the caller may kill (RBAC `kill:trigger`, then Cedar). */
  async mint(input: SocKillMintInput): Promise<SocKillMinted> {
    const { principal } = input;
    const tenantId = principal.tenantId;
    if (tenantId === null || tenantId.length === 0) {
      throw new AuthError('no tenant context on the authenticated principal', {
        detail: 'a tenant context is required',
      });
    }
    if (!hasPermission(principal.roles, 'kill:trigger')) {
      throw new KillApiError('KILL_FORBIDDEN', 'minting a kill link requires kill:trigger');
    }
    const resource = await this.resourceOf(tenantId, input.scope, input.scopeRefId);
    const decision = this.deps.policy.authorize(
      { userId: principal.id, tenantId, roles: principal.roles },
      resource,
    );
    if (decision.decision !== 'allow') {
      throw new KillApiError('KILL_FORBIDDEN', 'you are not permitted to kill this scope');
    }

    const now = this.clock.now();
    const expiresAt = await this.expiryFor(input, tenantId, now);
    const maxUses =
      input.maxUses ?? (input.scope === 'run' ? DEFAULT_RUN_MAX_USES : DEFAULT_ASSET_MAX_USES);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > LIMITS.killTokenUsesMax) {
      throw new ValidationError('invalid maxUses', {
        detail: `maxUses must be an integer from 1 to ${String(LIMITS.killTokenUsesMax)}`,
      });
    }

    const id = this.nextId();
    const token = signJws(
      {
        tenantId,
        scope: input.scope,
        scopeRefId: input.scopeRefId,
        jti: id,
        exp: Math.floor(expiresAt.getTime() / MS_PER_SECOND),
      } satisfies Claims,
      this.deps.signer,
    );
    const record: SocKillTokenRecord = {
      id,
      tenantId,
      scope: input.scope,
      scopeRefId: input.scopeRefId,
      tokenSha256: sha256(token),
      contactId: input.contactId ?? null,
      signingKeyId: this.deps.signer.kid,
      expiresAt: new Date(Math.floor(expiresAt.getTime() / MS_PER_SECOND) * MS_PER_SECOND),
      maxUses,
      useCount: 0,
      revokedAt: null,
    };
    await this.deps.store.insert(record);

    // A live link with no ledger entry must not exist: if the append fails, revoke it and fail.
    try {
      await this.deps.audit.append({
        action: 'soc_kill.link_minted',
        severity: 'notice',
        outcome: 'success',
        tenantId,
        actor:
          principal.type === 'user'
            ? { type: 'user', id: principal.id }
            : { type: 'service', id: principal.id },
        target: { type: input.scope, id: input.scopeRefId },
        occurredAt: now.toISOString(),
        traceId: input.traceId,
        metadata: {
          tokenId: id,
          scope: input.scope,
          scopeRefId: input.scopeRefId,
          maxUses,
          expiresAt: record.expiresAt.toISOString(),
          signingKeyId: record.signingKeyId,
        },
      });
    } catch (err) {
      this.deps.metrics.auditFailures.inc({ action: 'soc_kill.link_minted' });
      await this.deps.store.revoke(tenantId, id, now);
      throw err;
    }
    this.deps.logger.info(
      { jti: id, scope: input.scope, scopeRefId: input.scopeRefId, actorRef: principal.id },
      'soc kill link minted',
    );
    return {
      linkId: id,
      scope: input.scope,
      url: `${this.deps.linkOrigin.replace(/\/+$/, '')}/soc/kill/${token}`,
      expiresAt: record.expiresAt.toISOString(),
      maxUses,
    };
  }

  /** `GET /soc/kill/{token}`: is the link live, and what would it stop? Takes no use. */
  async preview(rawToken: string, ip: string): Promise<SocKillPreview> {
    const { claims } = await this.verify(rawToken, ip, 'verify');
    const label = await this.deps.context.scopeLabel(
      claims.tenantId,
      claims.scope,
      claims.scopeRefId,
    );
    this.deps.metrics.total.inc({ result: 'previewed' });
    return { scope: claims.scope, label: label ?? 'the tested system' };
  }

  /** `POST /soc/kill`: takes one use and starts the kill through the KILL-003 path. */
  async trigger(
    rawToken: string,
    ip: string,
    traceId: string | null,
  ): Promise<KillTriggerResponse> {
    const { claims, record } = await this.verify(rawToken, ip, 'trigger');
    const useCount = await this.deps.store.consume(claims.tenantId, record.id, this.clock.now());
    if (useCount === null) return this.reject('used', ip, claims);
    try {
      const { response } = await this.deps.kill.triggerFromSocLink({
        tenantId: claims.tenantId,
        scope: claims.scope,
        scopeRefId: claims.scopeRefId,
        tokenId: record.id,
        // One key per use: a retry of the same use joins its event instead of making another.
        idempotencyKey: `soc-kill-${record.id}-${String(useCount)}`,
        traceId,
      });
      this.deps.metrics.total.inc({ result: 'triggered' });
      this.deps.logger.info(
        { jti: record.id, scope: claims.scope, ip, killEventId: response.killEventId },
        'soc kill triggered',
      );
      return response;
    } catch (err) {
      // The kill never started, so the SOC must still be able to use the link.
      await this.deps.store.refund(claims.tenantId, record.id).catch((refundErr: unknown) => {
        this.deps.logger.error({ jti: record.id, err: refundErr }, 'soc kill use refund failed');
      });
      throw err;
    }
  }

  private async verify(rawToken: string, ip: string, op: Operation): Promise<Verified> {
    return this.tracer.startActiveSpan(SOC_KILL_VERIFY_SPAN, async (span) => {
      try {
        return await this.verifyInSpan(rawToken, ip, op, span);
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async verifyInSpan(
    rawToken: string,
    ip: string,
    op: Operation,
    span: Span,
  ): Promise<Verified> {
    this.limit(`ip:${op}:${ip}`, op === 'trigger' ? 'triggerPerIp' : 'verifyPerIp', op, ip);

    const verified = verifyJws(rawToken, this.deps.resolveKey);
    const parsed = verified === null ? null : claimsSchema.safeParse(verified.payload);
    if (verified === null || parsed?.success !== true) return this.reject('invalid_signature', ip, null);
    const claims = parsed.data;
    span.setAttributes({ 'bw.tenant_id': claims.tenantId, 'bw.soc_kill.jti': claims.jti });
    // Keyed by the verified jti, so garbage tokens cannot grow the limiter's memory.
    this.limit(
      `token:${op}:${claims.jti}`,
      op === 'trigger' ? 'triggerPerToken' : 'verifyPerToken',
      op,
      ip,
    );

    const now = this.clock.now().getTime();
    if (now > claims.exp * MS_PER_SECOND + SOC_KILL_LEEWAY_MS)
      return this.reject('expired', ip, claims);
    // Fail closed on a suspended or unknown tenant (only *stopping* is exempt from scope checks).
    if (!(await this.deps.context.tenantActive(claims.tenantId))) {
      return this.reject('tenant_suspended', ip, claims);
    }

    const hash = sha256(rawToken);
    const record = await this.deps.store.findBySha256(claims.tenantId, hash);
    if (
      record === null ||
      record.tokenSha256.length !== hash.length ||
      !timingSafeEqual(record.tokenSha256, hash) ||
      record.id !== claims.jti ||
      record.tenantId !== claims.tenantId ||
      record.scope !== claims.scope ||
      record.scopeRefId !== claims.scopeRefId ||
      record.signingKeyId !== verified.kid
    ) {
      return this.reject('unknown_token', ip, claims);
    }
    if (record.revokedAt !== null) return this.reject('revoked', ip, claims);
    if (now > record.expiresAt.getTime() + SOC_KILL_LEEWAY_MS)
      return this.reject('expired', ip, claims);
    if (record.useCount >= record.maxUses) return this.reject('used', ip, claims);
    return { claims, record };
  }

  private limit(key: string, which: keyof typeof SOC_KILL_LIMITS, op: Operation, ip: string): void {
    const verdict = this.deps.limiter.hit(key, SOC_KILL_LIMITS[which], MINUTE_MS);
    if (verdict.allowed) return;
    this.deps.metrics.ratelimited.inc({ op });
    this.deps.logger.warn({ ip, op, limit: which }, 'soc kill rate limited');
    throw new RateLimitedError('too many requests', {
      detail: 'too many requests; retry later',
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  /**
   * Counts, logs and audits a refusal, then throws the one generic answer. A bad signature has no
   * tenant to attribute an audit event to (and would let anyone spam a ledger), so it is a metric and
   * a log line only; every refusal of a genuinely signed link is audited `soc_kill.rejected{reason}`.
   */
  private async reject(
    reason: SocKillRejectReason,
    ip: string,
    claims: Claims | null,
  ): Promise<never> {
    this.deps.metrics.total.inc({ result: reason });
    this.deps.logger.warn({ reason, ip, jti: claims?.jti ?? null }, 'soc kill link refused');
    if (claims !== null) {
      try {
        await this.deps.audit.append({
          action: 'soc_kill.rejected',
          severity: 'warning',
          outcome: 'denied',
          tenantId: claims.tenantId,
          actor: { type: 'anonymous' },
          target: { type: claims.scope, id: claims.scopeRefId },
          occurredAt: this.clock.now().toISOString(),
          traceId: trace.getActiveSpan()?.spanContext().traceId ?? null,
          metadata: { reason, tokenId: claims.jti, scope: claims.scope, ip },
        });
      } catch (err) {
        this.deps.metrics.auditFailures.inc({ action: 'soc_kill.rejected' });
        this.deps.logger.error({ reason, jti: claims.jti, err }, 'soc kill audit append failed');
      }
    }
    throw new NotFoundError('this link is no longer valid', {
      detail: 'this link is no longer valid',
    });
  }

  private async resourceOf(
    tenantId: string,
    scope: SocKillTokenScope,
    refId: string,
  ): Promise<KillPolicyResource> {
    if (scope === 'run') {
      const run = await this.deps.resources.getRun(tenantId, refId);
      if (run === null) throw new NotFoundError('run not found');
      return { scope: 'run', id: run.id, tenantId: run.tenantId };
    }
    const asset = await this.deps.resources.getAsset(tenantId, refId);
    if (asset === null) throw new NotFoundError('asset not found');
    return {
      scope: 'asset',
      id: asset.id,
      tenantId: asset.tenantId,
      ownerUserIds: asset.ownerUserIds,
    };
  }

  /** Explicit expiry, else the end of the asset's open test window; always within the maximum. */
  private async expiryFor(input: SocKillMintInput, tenantId: string, now: Date): Promise<Date> {
    const limit = now.getTime() + SOC_KILL_MAX_VALIDITY_MS;
    const chosen =
      input.expiresAt ??
      (input.scope === 'asset'
        ? await this.deps.context.openWindowEnd(tenantId, input.scopeRefId, now)
        : null);
    if (chosen === null) {
      throw new ValidationError('no expiry for the kill link', {
        detail:
          input.scope === 'asset'
            ? 'the asset has no open test window; pass expiresAt'
            : 'a run kill link requires expiresAt',
      });
    }
    if (chosen.getTime() <= now.getTime()) {
      throw new ValidationError('kill link already expired', {
        detail: 'expiresAt must be in the future',
      });
    }
    return new Date(Math.min(chosen.getTime(), limit));
  }
}
