import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import { AppError, serializeErrorForLog } from '@blackwing/errors';
import { type EmailSender, renderEmail } from '@blackwing/notify';
import { type Clock, systemClock } from '@blackwing/time';

import { slugBase } from './slug.js';
import { hashSignupToken, logRef, newSignupToken } from './token.js';

import type { SignupMetrics } from './metrics.js';
import type { SignupStore, TenantProvisioningQueue } from './ports.js';
import type { SignupAccepted, SignupRequest, SignupVerified } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/signup';
const MS_PER_HOUR = 3_600_000;

export interface SignupServiceDeps {
  readonly store: SignupStore;
  readonly mailer: EmailSender;
  readonly provisioning: TenantProvisioningQueue;
  readonly logger: Logger;
  readonly metrics: SignupMetrics;
  readonly settings: {
    readonly tokenTtlHours: number;
    readonly region: string;
    /** The console page the link opens, without the fragment. */
    readonly verifyUrl: string;
    readonly emailMaxPerHour: number;
  };
  readonly clock?: Clock;
  readonly tracer?: Tracer;
}

/** The class and (SMTP or system) code of a thrown value, never its message. */
function errorLabels(error: unknown): { readonly errorName: string; readonly errorCode?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  };
}

const ACCEPTED: SignupAccepted = Object.freeze({ status: 'verification_requested' });

/**
 * Self-service signup (TENANT-004, F13). The request half never looks the address up: whether or not it
 * already has an account, the same row is stored, the same mail goes out and the same body comes back, so
 * the endpoint cannot be used to enumerate customers. The tenant exists only after the token is verified.
 *
 * Logs carry a short hash of the address and the signup id, never the address, the organisation name or
 * the token (§5, §8.7).
 */
export class SignupService {
  private readonly clock: Clock;
  private readonly tracer: Tracer;

  constructor(private readonly deps: SignupServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  /** `POST /v1/signup`: stores a pending signup and mails the link. Always resolves to the same answer. */
  request(input: SignupRequest): Promise<SignupAccepted> {
    return this.traced('signup.request', async () => {
      const { settings, store, logger, metrics } = this.deps;
      const email = input.email.trim().toLowerCase();
      // Throws a 422 for a name with no usable slug: the answer depends only on the name, not the address.
      const desiredSlug = slugBase(input.orgName);
      const now = this.clock.now();
      const token = newSignupToken();

      const stored = await store.request(
        {
          email,
          orgName: input.orgName,
          desiredSlug,
          tokenHash: hashSignupToken(token),
          expiresAt: new Date(now.getTime() + settings.tokenTtlHours * MS_PER_HOUR),
        },
        { since: new Date(now.getTime() - MS_PER_HOUR), max: settings.emailMaxPerHour },
      );
      if (stored === null) {
        metrics.requested.inc({ result: 'throttled' });
        logger.warn({ emailRef: logRef(email) }, 'signup.request.throttled');
        return ACCEPTED;
      }

      try {
        await this.deps.mailer.send(
          renderEmail('signup_verify', email, {
            verifyUrl: `${settings.verifyUrl}#token=${token}`,
            orgName: input.orgName,
            expiresInHours: settings.tokenTtlHours,
          }),
        );
        metrics.requested.inc({ result: 'accepted' });
        logger.info({ signupId: stored.id, emailRef: logRef(email) }, 'signup.requested');
      } catch (error) {
        // The row stays pending. The answer must not depend on delivery either, so it is still the 202;
        // the address can ask again, and the failure counter pages an operator.
        metrics.requested.inc({ result: 'email_failed' });
        // A relay error message may quote the recipient, so only its class and code are logged.
        logger.error(
          { signupId: stored.id, emailRef: logRef(email), ...errorLabels(error) },
          'signup.email_failed',
        );
      }
      return ACCEPTED;
    });
  }

  /** `POST /v1/signup/verify`: consumes the token and creates the tenant. */
  verify(token: string): Promise<SignupVerified> {
    return this.traced('signup.verify', async () => {
      const { store, logger, metrics, settings } = this.deps;
      const outcome = await store.verify({
        tokenHash: hashSignupToken(token),
        now: this.clock.now(),
        region: settings.region,
      });

      if (outcome.kind === 'invalid') {
        metrics.tokenInvalid.inc();
        throw new AppError('SIGNUP_TOKEN_INVALID', 'signup token invalid', {
          detail: 'The verification link is invalid, expired or already used. Request a new one.',
        });
      }
      if (outcome.kind === 'existing_account') {
        metrics.verified.inc({ outcome: 'existing_account' });
        logger.info({ signupId: outcome.signupId }, 'signup.verified.existing_account');
        return { outcome: 'existing_account' };
      }

      metrics.verified.inc({ outcome: 'tenant_created' });
      logger.info(
        { signupId: outcome.signupId, tenantId: outcome.tenantId, userId: outcome.userId },
        'signup.verified',
      );
      try {
        await this.deps.provisioning.enqueue({
          tenantId: outcome.tenantId,
          slug: outcome.slug,
          name: outcome.orgName,
        });
      } catch (error) {
        // The tenant is committed and must stay: TENANT-005 reconciles tenants that have no Organization.
        metrics.provisioningFailures.inc();
        logger.error(
          { tenantId: outcome.tenantId, err: serializeErrorForLog(error) },
          'signup.provisioning_enqueue_failed',
        );
      }
      return { outcome: 'tenant_created', tenantId: outcome.tenantId, slug: outcome.slug };
    });
  }

  private async traced<T>(name: string, run: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span: Span) => {
      try {
        return await run();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
