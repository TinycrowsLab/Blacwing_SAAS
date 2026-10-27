import type { KillAuditSink } from '../kill/ports.js';

/**
 * Ports of the SOC kill link (KILL-007). Adapters (Postgres under `withTenant`, #95) live elsewhere;
 * every method is tenant-scoped, so the public path sets `app.tenant_id` from the VERIFIED token
 * before any row is read, and an adapter can never return another tenant's row.
 */

/** A stored link, as `soc_kill_tokens` holds it. The raw token is never stored (only its SHA-256). */
export interface SocKillTokenRecord {
  /** Equals the token's `jti`. */
  readonly id: string;
  readonly tenantId: string;
  readonly scope: 'asset' | 'run';
  readonly scopeRefId: string;
  readonly tokenSha256: Buffer;
  readonly contactId: string | null;
  readonly signingKeyId: string;
  readonly expiresAt: Date;
  readonly maxUses: number;
  readonly useCount: number;
  readonly revokedAt: Date | null;
}

export interface SocKillTokenStore {
  insert(record: SocKillTokenRecord): Promise<void>;
  /** Looks a link up by the SHA-256 of the raw token (unique index). */
  findBySha256(tenantId: string, sha256: Buffer): Promise<SocKillTokenRecord | null>;
  /**
   * Atomically takes one use: `use_count + 1` only while `use_count < max_uses` and the link is not
   * revoked. Returns the new use count, or `null` when no use was left (a concurrent winner).
   */
  consume(tenantId: string, id: string, at: Date): Promise<number | null>;
  /** Gives back a use taken by {@link consume} when the kill could not be started. */
  refund(tenantId: string, id: string): Promise<void>;
  revoke(tenantId: string, id: string, at: Date): Promise<void>;
}

/** Tenant and asset facts the link needs, read through the tenant data-access layer. */
export interface SocKillContext {
  /** False for a suspended, deleted or unknown tenant: its links are refused. */
  tenantActive(tenantId: string): Promise<boolean>;
  /** The label shown on the confirmation page: an asset's name, or the asset a run is testing. */
  scopeLabel(tenantId: string, scope: 'asset' | 'run', scopeRefId: string): Promise<string | null>;
  /** End of the asset's open test window (the latest, if several), or `null` when none is open. */
  openWindowEnd(tenantId: string, assetId: string, at: Date): Promise<Date | null>;
}

/** The verdict of one rate-limit check. */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Whole seconds until the bucket frees up; sent as `Retry-After` on a 429. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one hit against `key`: at most `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number): RateLimitVerdict;
}

export type SocKillAuditSink = KillAuditSink;
