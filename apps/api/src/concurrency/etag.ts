import { createHash } from 'node:crypto';

/** Hex characters of the content hash used when a resource has no `state_version`. */
const ETAG_HASH_LENGTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCanonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toCanonical(item) ?? null);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = value[key];
      if (member === undefined || typeof member === 'function' || typeof member === 'symbol')
        continue;
      out[key] = toCanonical(member);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped (as `JSON.stringify` does),
 * dates as ISO strings, bigints as decimal strings. Equal resources always serialise identically.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  return JSON.stringify(toCanonical(value));
}

/** The version of a row: `state_version` (or `stateVersion`) when it is a non-negative safe integer. */
export function stateVersionOf(resource: unknown): number | undefined {
  if (!isRecord(resource)) return undefined;
  const raw = resource.state_version ?? resource.stateVersion;
  const version = typeof raw === 'bigint' ? Number(raw) : raw;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
    ? version
    : undefined;
}

/** The strong ETag of a version number: `"v7"`. */
export function versionEtag(version: number): string {
  return `"v${String(version)}"`;
}

/**
 * The strong validator of a resource: `"v{state_version}"` when the row carries a version, else the
 * first 16 hex characters of the SHA-256 of its canonical JSON. Nothing secret is exposed: the hash
 * is one-way and truncated.
 */
export function computeEtag(resource: unknown): string {
  const version = stateVersionOf(resource);
  if (version !== undefined) return versionEtag(version);
  const digest = createHash('sha256').update(canonicalize(resource)).digest('hex');
  return `"${digest.slice(0, ETAG_HASH_LENGTH)}"`;
}

/** The `state_version` encoded in a version ETag (`"v7"` gives 7), or undefined for a hash ETag. */
export function versionFromEtag(etag: string): number | undefined {
  const match = /^"v(\d{1,15})"$/.exec(etag);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
