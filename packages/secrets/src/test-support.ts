import type { OpenBaoClient, OpenBaoResponse } from './openbao.js';

/**
 * In-memory stand-in for the Transit + KV v2 endpoints the KEK service uses. It models version
 * numbers and `min_decryption_version`; encryption itself is covered by the integration test.
 */
export class FakeOpenBao implements OpenBaoClient {
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly keys = new Map<string, Record<string, unknown>>();
  readonly kv = new Map<string, unknown>();
  /** Set to make every call fail like a sealed server. */
  down = false;

  request(method: string, path: string, body?: unknown): Promise<OpenBaoResponse> {
    this.calls.push({ method, path, body });
    if (this.down) return Promise.reject(new Error('sealed'));
    const kvMatch = /^secret\/data\/(.+)$/.exec(path);
    if (kvMatch?.[1] !== undefined) {
      const key = kvMatch[1];
      if (method === 'POST') {
        this.kv.set(key, (body as { data: unknown }).data);
        return Promise.resolve({ status: 204, data: undefined });
      }
      return Promise.resolve(
        this.kv.has(key)
          ? { status: 200, data: { data: this.kv.get(key) } }
          : { status: 404, data: undefined },
      );
    }
    const m = /^transit\/keys\/([^/]+)(?:\/(config|rotate))?$/.exec(path);
    if (m?.[1] === undefined) return Promise.resolve({ status: 404, data: undefined });
    const name = m[1];
    const action = m[2];
    const key = this.keys.get(name);
    if (action === undefined && method === 'POST') {
      if (!key) {
        const b = body as Record<string, unknown>;
        this.keys.set(name, {
          type: b.type,
          exportable: b.exportable,
          allow_plaintext_backup: b.allow_plaintext_backup,
          latest_version: 1,
          min_decryption_version: 1,
          deletion_allowed: false,
        });
      }
      return Promise.resolve({ status: 204, data: undefined });
    }
    if (!key) return Promise.resolve({ status: 404, data: undefined });
    if (action === 'rotate') key.latest_version = (key.latest_version as number) + 1;
    else if (action === 'config') Object.assign(key, body);
    else return Promise.resolve({ status: 200, data: { ...key } });
    return Promise.resolve({ status: 200, data: { ...key } });
  }
}
