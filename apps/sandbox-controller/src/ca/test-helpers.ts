import { AppError } from '@blackwing/errors';

import type { RunCaAuditEvent, RunCaAuditEmitter } from './run-ca.js';
import type { OpenBaoClient, OpenBaoResponse } from '@blackwing/secrets';

export const TENANT = '01930000-0000-7000-8000-00000000000a';
export const OTHER_TENANT = '01930000-0000-7000-8000-00000000000b';
export const RUN = '01930000-0000-7000-8000-0000000000a1';
export const NOW = new Date('2026-10-30T10:00:00.000Z');
export const RUN_END = '2026-10-30T11:00:00.000Z';
export const SA_EXPIRY = '2026-11-30T00:00:00.000Z';

/**
 * In-memory stand-in for the KV v2 subset the run-CA issuer uses: data reads (404 when absent), `cas: 0`
 * creates (rejects an existing path, as OpenBao does with a 400), and metadata deletes that remove every
 * version. `failOn` injects an outage (sealed, unreachable) for one request.
 */
export function fakeOpenBao(failOn?: (method: string, path: string) => boolean): OpenBaoClient & {
  readonly records: Map<string, string>;
  readonly calls: { method: string; path: string }[];
} {
  const records = new Map<string, string>();
  const calls: { method: string; path: string }[] = [];
  return {
    records,
    calls,
    request(method: string, path: string, body?: unknown): Promise<OpenBaoResponse> {
      calls.push({ method, path });
      if (failOn?.(method, path)) {
        return Promise.reject(new AppError('KEK_UNAVAILABLE', 'OpenBao is unreachable'));
      }
      if (method === 'GET') {
        const pem = records.get(path);
        if (pem === undefined) return Promise.resolve({ status: 404, data: undefined });
        return Promise.resolve({ status: 200, data: { data: { pem }, metadata: {} } });
      }
      if (method === 'POST') {
        const payload = body as { data: { pem: string }; options?: { cas?: number } };
        if (payload.options?.cas === 0 && records.has(path)) {
          return Promise.reject(
            new AppError('INTERNAL', `OpenBao rejected POST ${path} (status 400)`),
          );
        }
        records.set(path, payload.data.pem);
        return Promise.resolve({ status: 200, data: { version: 1 } });
      }
      if (method === 'DELETE') {
        const dataPath = path.replace(/^secret\/metadata\//, 'secret/data/');
        records.delete(dataPath);
        return Promise.resolve({ status: 204, data: undefined });
      }
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    },
  };
}

export function captureAudit(): RunCaAuditEmitter & { readonly events: RunCaAuditEvent[] } {
  const events: RunCaAuditEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}
