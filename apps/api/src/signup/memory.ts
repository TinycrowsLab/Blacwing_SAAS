import { newId } from '@blackwing/ids';

import { slugCandidate } from './slug.js';

import type {
  PendingSignup,
  RequestThrottle,
  SignupStore,
  VerifySignupInput,
  VerifySignupOutcome,
} from './ports.js';
import type { SignupStatus } from '@blackwing/contracts';

/** A signup row as the in-memory store keeps it. */
export interface MemorySignup extends PendingSignup {
  readonly id: string;
  status: SignupStatus;
  readonly createdAt: Date;
}

/** An audit event the in-memory store would have written in the verify transaction. */
export interface MemoryAuditEvent {
  readonly action: 'signup.verified' | 'tenant.created';
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetId: string;
}

/**
 * In-memory {@link SignupStore} with the semantics of the Postgres adapter, for unit and HTTP tests. JS is
 * single-threaded and `verify` never awaits between its check and its writes, so it is atomic here the way
 * the row lock makes it atomic there.
 */
export class InMemorySignupStore implements SignupStore {
  readonly signups: MemorySignup[] = [];
  readonly users = new Map<string, { readonly id: string }>();
  readonly tenants = new Map<
    string,
    { readonly id: string; readonly name: string; readonly region: string }
  >();
  readonly memberships: { tenantId: string; userId: string; roles: readonly string[] }[] = [];
  readonly audit: MemoryAuditEvent[] = [];
  /** Test seam: the clock for `createdAt`. */
  now: () => Date = () => new Date();

  request(signup: PendingSignup, throttle: RequestThrottle): Promise<{ id: string } | null> {
    const mine = this.signups.filter((row) => row.email === signup.email);
    const recent = mine.filter((row) => row.createdAt >= throttle.since).length;
    if (recent >= throttle.max) return Promise.resolve(null);
    for (const row of mine) if (row.status === 'pending') row.status = 'cancelled';
    const row: MemorySignup = { ...signup, id: newId(), status: 'pending', createdAt: this.now() };
    this.signups.push(row);
    return Promise.resolve({ id: row.id });
  }

  verify(input: VerifySignupInput): Promise<VerifySignupOutcome> {
    return Promise.resolve(this.verifySync(input));
  }

  private verifySync({ tokenHash, now, region }: VerifySignupInput): VerifySignupOutcome {
    const row = this.signups.find((candidate) => candidate.tokenHash === tokenHash);
    if (row?.status !== 'pending') return { kind: 'invalid' };
    if (row.expiresAt <= now) {
      row.status = 'expired';
      return { kind: 'invalid' };
    }
    row.status = 'verified';
    if (this.users.has(row.email)) return { kind: 'existing_account', signupId: row.id };

    const userId = newId();
    const tenantId = newId();
    this.users.set(row.email, { id: userId });
    let attempt = 1;
    while (this.tenants.has(slugCandidate(row.desiredSlug, attempt))) attempt += 1;
    const slug = slugCandidate(row.desiredSlug, attempt);
    this.tenants.set(slug, { id: tenantId, name: row.orgName, region });
    this.memberships.push({ tenantId, userId, roles: ['org_admin'] });
    this.audit.push(
      { action: 'signup.verified', tenantId, actorUserId: userId, targetId: userId },
      { action: 'tenant.created', tenantId, actorUserId: userId, targetId: tenantId },
    );
    return { kind: 'created', signupId: row.id, tenantId, userId, slug, orgName: row.orgName };
  }
}
