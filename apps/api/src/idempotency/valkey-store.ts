import {
  idempotencyRecordSchema,
  type CompletedRecord,
  type IdempotencyRecord,
  type InProgressRecord,
} from './record.js';

import type { AcquireResult, IdempotencyStore } from './ports.js';

/**
 * The slice of an ioredis client the store uses (structural, so the API needs no driver dependency and
 * tests can pass a fake). ioredis `Redis` satisfies it.
 */
export interface ValkeyCommandClient {
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    milliseconds: number,
    setMode: 'NX',
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** Raised when a stored value cannot be read back: the store is treated as unavailable (fail closed). */
export class IdempotencyRecordCorruptError extends Error {
  constructor() {
    super('idempotency record is not valid');
    this.name = 'IdempotencyRecordCorruptError';
  }
}

/**
 * Both scripts act only when the stored record is still the `in_progress` one this request created
 * (same owner token). A lock that expired and was re-taken by a retry is never overwritten or deleted.
 */
const COMPLETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if ok and type(record) == 'table' and record.state == 'in_progress' and record.token == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`;

const RELEASE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if ok and type(record) == 'table' and record.state == 'in_progress' and record.token == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0`;

function parseRecord(raw: string): IdempotencyRecord {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new IdempotencyRecordCorruptError();
  }
  const parsed = idempotencyRecordSchema.safeParse(json);
  if (!parsed.success) throw new IdempotencyRecordCorruptError();
  return parsed.data;
}

/** Valkey adapter of {@link IdempotencyStore}: `SET NX PX` for the lock, token-checked scripts after. */
export class ValkeyIdempotencyStore implements IdempotencyStore {
  readonly #client: ValkeyCommandClient;

  constructor(client: ValkeyCommandClient) {
    this.#client = client;
  }

  async acquire(key: string, record: InProgressRecord, lockTtlMs: number): Promise<AcquireResult> {
    const set = await this.#client.set(key, JSON.stringify(record), 'PX', lockTtlMs, 'NX');
    if (set === 'OK') return { acquired: true };
    const raw = await this.#client.get(key);
    return { acquired: false, existing: raw === null ? null : parseRecord(raw) };
  }

  async complete(
    key: string,
    token: string,
    record: CompletedRecord,
    ttlMs: number,
  ): Promise<boolean> {
    const reply = await this.#client.eval(
      COMPLETE_SCRIPT,
      1,
      key,
      token,
      JSON.stringify(record),
      String(ttlMs),
    );
    return reply === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    return (await this.#client.eval(RELEASE_SCRIPT, 1, key, token)) === 1;
  }
}
