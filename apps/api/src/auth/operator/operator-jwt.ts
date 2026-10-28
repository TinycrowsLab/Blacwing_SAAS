import { z } from 'zod';

import {
  OPERATOR_STRONG_ACR,
  operatorPrincipalSchema,
  type OperatorPrincipal,
} from '@blackwing/contracts';

import { AuthInvalidTokenError } from '../errors.js';
import {
  assertNotFromFuture,
  type JwtVerificationOptions,
  verifySignature,
} from '../keycloak-jwt.js';
import { OperatorMfaRequiredError } from './errors.js';

import type { JWTPayload } from 'jose';

/*
 * The platform-operator access token validator (#838). Operator tokens come from the separate `blackwing-operators`
 * realm and carry `aud=operator-api`. The signature, algorithm, issuer, audience and time claims go through the same
 * hardened path as the tenant validator (IAM-007). The principal has no tenant, and `acr` must be `operator_strong`.
 */

const claimsSchema = z.object({
  sub: z.string().min(1),
  acr: z.string().min(1).optional(),
  auth_time: z.number().optional(),
  jti: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).optional(),
  realm_access: z.object({ roles: z.array(z.string().min(1)) }).optional(),
});

export type OperatorJwtOptions = JwtVerificationOptions;

export interface OperatorJwtValidator {
  /**
   * Verifies an operator access token and returns the operator principal. Throws `AppError`s only:
   * `OperatorMfaRequiredError` when the token is genuine but the second factor was not completed.
   */
  validate(token: string): Promise<OperatorPrincipal>;
}

export function createOperatorJwtValidator(options: OperatorJwtOptions): OperatorJwtValidator {
  return {
    async validate(token) {
      const payload = await verifySignature(token, options);
      return operatorPrincipalOf(payload, options);
    },
  };
}

/**
 * Builds the operator principal from verified claims. Fails closed on anything it cannot place: a tenant claim, a
 * missing or weaker `acr` (MFA), a future `auth_time`, or a malformed subject.
 */
function operatorPrincipalOf(
  payload: JWTPayload,
  options: Pick<JwtVerificationOptions, 'leewaySeconds' | 'now'>,
): OperatorPrincipal {
  // An operator token never names a tenant. A tenant claim here is a misissued or forged token: refuse it.
  if ('tenantId' in payload)
    throw new AuthInvalidTokenError('operator token carries a tenant claim');
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new AuthInvalidTokenError('operator subject claim is invalid');
  const c = claims.data;
  assertNotFromFuture(payload.iat, options);
  assertNotFromFuture(c.auth_time, options, 'auth_time');
  if (c.acr !== OPERATOR_STRONG_ACR) throw new OperatorMfaRequiredError();
  const principal = operatorPrincipalSchema.safeParse({
    operatorId: c.sub,
    kind: 'operator',
    roles: c.roles ?? c.realm_access?.roles ?? [],
    acr: OPERATOR_STRONG_ACR,
    ...(c.jti === undefined ? {} : { tokenId: c.jti }),
    authMethod: 'operator_jwt',
  });
  if (!principal.success) throw new AuthInvalidTokenError('operator principal is invalid');
  return principal.data;
}
