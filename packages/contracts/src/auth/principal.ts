import { z } from 'zod';

const MAX_ID_CHARS = 256;
const MAX_LABEL_CHARS = 128;
const MAX_LIST_ITEMS = 256;

/**
 * The validated caller every authenticated request carries (IAM, CONTEXT_PACK §9). One shape for every
 * credential: whichever validator accepted the request attaches exactly this, so tenant context and RBAC
 * never branch on how the caller authenticated. Shared with the `bw_pat_`/`bw_ci_` validator (RBAC-007).
 */
export const principalSchema = z.strictObject({
  /** The Keycloak `sub` (a user or a service account) or the BFF session's subject. */
  subjectId: z.string().min(1).max(MAX_ID_CHARS),
  kind: z.enum(['user', 'service']),
  /** The tenant the credential is bound to. Lower-case canonical UUID. */
  tenantId: z.uuid(),
  roles: z.array(z.string().min(1).max(MAX_LABEL_CHARS)).max(MAX_LIST_ITEMS),
  scopes: z.array(z.string().min(1).max(MAX_LABEL_CHARS)).max(MAX_LIST_ITEMS),
  /** Authentication context class reported by the IdP, when it reported one. */
  acr: z.string().min(1).max(MAX_LABEL_CHARS).optional(),
  authMethod: z.enum(['keycloak_jwt', 'bff_session']),
});

export type Principal = z.infer<typeof principalSchema>;

/**
 * The platform operator (#838, CONTEXT_PACK §1.2): Blackwing staff authenticated in the separate
 * `blackwing-operators` realm. It carries NO tenant. The schema is strict and has no `tenantId`, so an operator
 * principal cannot be handed to a tenant-scoped path; `withTenant` fails closed without a tenant. The only
 * accepted `acr` is `operator_strong`: a principal that did not complete the operator second factor cannot exist.
 */
export const OPERATOR_STRONG_ACR = 'operator_strong';

export const operatorPrincipalSchema = z.strictObject({
  /** The operator realm's `sub` for the operator. */
  operatorId: z.string().min(1).max(MAX_ID_CHARS),
  kind: z.literal('operator'),
  /** Platform roles from the operator realm (`platform_operator`, `verification_reviewer`, `platform_admin`). */
  roles: z.array(z.string().min(1).max(MAX_LABEL_CHARS)).max(MAX_LIST_ITEMS),
  acr: z.literal(OPERATOR_STRONG_ACR),
  /** The token id (`jti`) of the access token, or the session id for a BFF session; for audit correlation. */
  tokenId: z.string().min(1).max(MAX_ID_CHARS).optional(),
  authMethod: z.enum(['operator_jwt', 'operator_session']),
});

export type OperatorPrincipal = z.infer<typeof operatorPrincipalSchema>;
