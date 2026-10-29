import { errors as joseErrors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { z } from 'zod';

import { principalSchema, type Principal } from '@blackwing/contracts';

import { AuthExpiredError, AuthInvalidTokenError, JwksUnavailableError } from './errors.js';

/**
 * The algorithms a Keycloak access token may use. Pinned here, never taken from the token header, so
 * `none` and HMAC-with-the-public-key confusion are refused before any key is used.
 */
const KEYCLOAK_ALGORITHMS: readonly string[] = ['RS256', 'ES256'];

const MS_PER_SECOND = 1000;

/** Service-account users are named `service-account-<client>` by Keycloak. */
const SERVICE_ACCOUNT_PREFIX = 'service-account-';

const claimsSchema = z.object({
  sub: z.string().min(1),
  tenantId: z.string().min(1),
  roles: z.array(z.string().min(1)).optional(),
  realm_access: z.object({ roles: z.array(z.string().min(1)) }).optional(),
  scope: z.string().optional(),
  acr: z.string().min(1).optional(),
  auth_time: z.number().int().nonnegative().optional(),
  preferred_username: z.string().optional(),
});

/** The Keycloak (tenant realm) validator's options: the same verification, for the `blackwing-api` audience. */
export type KeycloakJwtOptions = JwtVerificationOptions;

/** What signature and claim verification needs. Shared with the platform-operator validator (#838). */
export interface JwtVerificationOptions {
  /** The realm URL; must equal the token's `iss` exactly. */
  readonly issuer: string;
  /** The audience the validator accepts (`blackwing-api`, or `operator-api` for the operator realm). */
  readonly audience: string;
  /** Clock-skew tolerance, in seconds, applied to `exp`, `nbf` and `iat`. */
  readonly leewaySeconds: number;
  readonly resolveKey: JWTVerifyGetKey;
  readonly now: () => number;
}

export interface KeycloakJwtValidator {
  /** Verifies a Keycloak access token and returns the principal it carries. Throws `AppError`s only. */
  validate(token: string): Promise<Principal>;
}

/** Verifies a Keycloak-issued JWT and maps its claims to the canonical {@link Principal}. Fails closed. */
export function createKeycloakJwtValidator(options: KeycloakJwtOptions): KeycloakJwtValidator {
  return {
    async validate(token) {
      const payload = await verifySignature(token, options);
      return principalOf(payload, options);
    },
  };
}

/**
 * Verifies a token's signature, algorithm (pinned), issuer, audience and time claims. Throws `AppError`s only.
 * Every JWT validator in the API goes through here, so the hardening is one code path (IAM-007, #838).
 */
export async function verifySignature(
  token: string,
  options: JwtVerificationOptions,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, options.resolveKey, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: [...KEYCLOAK_ALGORITHMS],
      clockTolerance: options.leewaySeconds,
      currentDate: new Date(options.now()),
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    return payload;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new AuthExpiredError('access token expired', { cause: error });
    }
    if (error instanceof JwksUnavailableError) {
      // Alert-worthy: a cold cache and an unreachable IdP. The caller still gets a plain 401.
      throw new AuthInvalidTokenError('signing keys unavailable', { cause: error });
    }
    throw new AuthInvalidTokenError('token verification failed', { cause: error });
  }
}

/**
 * `iat` (or any other timestamp claim) in the future beyond the leeway is a forged or badly clocked token: refuse it.
 * An absent claim is not judged here.
 */
export function assertNotFromFuture(
  epochSeconds: number | undefined,
  options: Pick<JwtVerificationOptions, 'leewaySeconds' | 'now'>,
  claim = 'iat',
): void {
  if (epochSeconds === undefined) return;
  if (epochSeconds * MS_PER_SECOND > options.now() + options.leewaySeconds * MS_PER_SECOND) {
    throw new AuthInvalidTokenError(`token ${claim} is in the future`);
  }
}

function principalOf(payload: JWTPayload, options: KeycloakJwtOptions): Principal {
  assertNotFromFuture(payload.iat, options);
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new AuthInvalidTokenError('tenant or subject claim is invalid');
  const c = claims.data;
  const candidate = {
    subjectId: c.sub,
    kind: c.preferred_username?.startsWith(SERVICE_ACCOUNT_PREFIX) ? 'service' : 'user',
    tenantId: c.tenantId,
    roles: c.roles ?? c.realm_access?.roles ?? [],
    scopes: (c.scope ?? '').split(' ').filter((scope) => scope !== ''),
    ...(c.acr === undefined ? {} : { acr: c.acr }),
    ...(c.auth_time === undefined ? {} : { authTime: c.auth_time }),
    authMethod: 'keycloak_jwt',
  };
  const principal = principalSchema.safeParse(candidate);
  if (!principal.success) throw new AuthInvalidTokenError('tenant or subject claim is invalid');
  return principal.data;
}
