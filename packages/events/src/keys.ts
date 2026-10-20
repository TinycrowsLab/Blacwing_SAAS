import { TenantContextMissingError, ValidationError } from '@blackwing/errors';

/**
 * A key segment is an identifier (UUID or prefixed public id). Colons, braces, glob characters,
 * whitespace and anything else that could change the shape of a key are refused, so a caller can
 * never address another tenant's or run's stream by smuggling a separator into an id (§8.6).
 */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Prefix of every key this package writes. */
const KEY_ROOT = 'bw';

export function assertSegment(label: string, value: unknown): string {
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    throw new ValidationError(`${label} must be 1-64 characters of [A-Za-z0-9_-]`);
  }
  return value;
}

/** Validates a tenant id used in a key. An absent tenant fails closed. */
export function assertTenantSegment(tenantId: unknown): string {
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    throw new TenantContextMissingError('the event bus requires a tenant id');
  }
  return assertSegment('tenantId', tenantId);
}

/** Validates a run id used in a key. */
function assertRunSegment(runId: unknown): string {
  return assertSegment('runId', runId);
}

/** The run event stream key: `bw:{tenantId}:run:{runId}:events` (§8.6 tenant + run scoping). */
export function runEventsKey(tenantId: string, runId: string): string {
  return `${KEY_ROOT}:${assertTenantSegment(tenantId)}:run:${assertRunSegment(runId)}:events`;
}

/** A stream entry id: `<ms>-<seq>`. */
export interface StreamId {
  readonly ms: bigint;
  readonly seq: bigint;
}

const STREAM_ID = /^(\d{1,20})-(\d{1,20})$/;

/** Parses a concrete stream id (`1700000000000-3`); a bare `<ms>` means `<ms>-0`. */
export function parseStreamId(id: string): StreamId | undefined {
  const full = STREAM_ID.exec(id);
  if (full !== null) return { ms: BigInt(full[1] ?? '0'), seq: BigInt(full[2] ?? '0') };
  if (/^\d{1,20}$/.test(id)) return { ms: BigInt(id), seq: 0n };
  return undefined;
}

/** Orders two stream ids: negative when `a` is before `b`. */
export function compareStreamIds(a: StreamId, b: StreamId): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}
