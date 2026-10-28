/**
 * Ports of the self-service signup (TENANT-004). The Postgres adapter (`postgres-store.ts`) is the
 * production one; `memory.ts` mirrors its behaviour for unit tests.
 */

/** A signup waiting for its address to be verified. Only the hash of the token is ever handed over. */
export interface PendingSignup {
  readonly email: string;
  readonly orgName: string;
  /** Slug base derived from `orgName`; collisions are resolved when the tenant is created. */
  readonly desiredSlug: string;
  /** Lower-case hex SHA-256 of the token. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** Limit on how many verification mails one address may ask for. */
export interface RequestThrottle {
  /** Only requests created at or after this instant count. */
  readonly since: Date;
  /** The most requests allowed in that window. */
  readonly max: number;
}

export interface VerifySignupInput {
  readonly tokenHash: string;
  readonly now: Date;
  /** Data region a new tenant is pinned to. */
  readonly region: string;
}

/**
 * What a verification did.
 *  - `invalid`: unknown, expired, already used or cancelled token. Nothing was created.
 *  - `existing_account`: the address already has an account, so no second tenant was created; the
 *    signup is closed and the caller goes to login.
 *  - `created`: the tenant, the owner user (new) and the membership now exist.
 */
export type VerifySignupOutcome =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'existing_account'; readonly signupId: string }
  | {
      readonly kind: 'created';
      readonly signupId: string;
      readonly tenantId: string;
      readonly userId: string;
      readonly slug: string;
      readonly orgName: string;
    };

export interface SignupStore {
  /**
   * Cancels the address's earlier pending signups (only the newest link works) and stores this one.
   * Returns `null`, storing nothing, when the address already asked for `throttle.max` links in the window.
   */
  request(
    signup: PendingSignup,
    throttle: RequestThrottle,
  ): Promise<{ readonly id: string } | null>;
  /**
   * Consumes a token in ONE transaction: marks the signup verified, creates the owner user if the address
   * is new, the tenant (unique slug) and the owner membership, and writes the `signup.verified` and
   * `tenant.created` audit events. Concurrent calls for one token create one tenant; the others see
   * `invalid`. Any failure rolls everything back, token included, so the caller may retry.
   */
  verify(input: VerifySignupInput): Promise<VerifySignupOutcome>;
}

/** What TENANT-005 needs to link the new tenant to a Keycloak Organization. */
export interface TenantProvisioningRequest {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Hands a new tenant to Keycloak Organization provisioning (TENANT-005). Called after the tenant is
 * committed. Provisioning is idempotent and reconciled by TENANT-005, so a failure here never undoes
 * the tenant; the caller logs it.
 */
export interface TenantProvisioningQueue {
  enqueue(request: TenantProvisioningRequest): Promise<void>;
}
