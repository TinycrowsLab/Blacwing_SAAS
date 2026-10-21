import { describe, expect, it } from 'vitest';

import {
  createRedactionRegistry,
  redactFailClosed,
  type RedactionAuditEvent,
  type RedactionMetrics,
} from './redaction.js';

const T = 'tenant-a';
const SECRET = 'Zx9!qLm2#Rt7vWp4';

function setup(over: { graceMs?: number; maxScanChars?: number } = {}) {
  const audits: RedactionAuditEvent[] = [];
  const hitCalls: number[] = [];
  const clock = { t: 1_000 };
  const metrics: RedactionMetrics = {
    size: () => undefined,
    hits: (_r, n) => hitCalls.push(n),
    failClosed: () => undefined,
  };
  const registry = createRedactionRegistry({
    audit: (e) => {
      audits.push(e);
      return Promise.resolve();
    },
    metrics,
    now: () => clock.t,
    ...over,
  });
  return { registry, audits, hitCalls, clock };
}

describe('redaction registry', () => {
  it('redacts raw, base64, base64url, url, json and hex forms', async () => {
    const { registry } = setup();
    await registry.register(T, 'r1', { label: 'db-pass', value: SECRET });
    const b64 = Buffer.from(SECRET).toString('base64');
    const url = encodeURIComponent(SECRET);
    const json = JSON.stringify(SECRET).slice(1, -1);
    const hex = Buffer.from(SECRET).toString('hex');
    const text = `a ${SECRET} b ${b64} c ${url} d ${json} e ${hex} f`;
    const res = registry.redact(T, 'r1', text);
    expect(res.text).toBe(
      'a ***REDACTED:db-pass*** b ***REDACTED:db-pass*** c ***REDACTED:db-pass*** d ***REDACTED:db-pass*** e ***REDACTED:db-pass*** f',
    );
    expect(res.hits).toBe(5);
    for (const form of [SECRET, b64, url, hex]) expect(res.text).not.toContain(form);
  });

  it('redacts a JSON-escaped form with quotes and backslashes', async () => {
    const { registry } = setup();
    const v = 'pa"ss\\word-9Xk2Lq';
    await registry.register(T, 'r1', { label: 'p', value: v });
    const res = registry.redact(T, 'r1', `{"x":${JSON.stringify(v)}}`);
    expect(res.text).toBe('{"x":"***REDACTED:p***"}');
  });

  it('does not globally redact short or low-entropy values', async () => {
    const { registry } = setup();
    expect(await registry.register(T, 'r1', { label: 'u', value: 'admin' })).toEqual({
      registered: false,
      reason: 'too-short',
    });
    expect(await registry.register(T, 'r1', { label: 'u', value: 'aaaaaaaaaaaa' })).toEqual({
      registered: false,
      reason: 'low-entropy',
    });
    expect(registry.redact(T, 'r1', 'user admin aaaaaaaaaaaa').hits).toBe(0);
  });

  it('always redacts a registered high-value token', async () => {
    const { registry } = setup();
    expect(
      (await registry.register(T, 'r1', { label: 't', value: 'abc', highValue: true })).registered,
    ).toBe(true);
    expect(registry.redact(T, 'r1', 'tok abc').text).toBe('tok ***REDACTED:t***');
  });

  it('redacts a secret split across stream chunks', async () => {
    const { registry } = setup();
    await registry.register(T, 'r1', { label: 'db', value: SECRET });
    const s = registry.createStream(T, 'r1');
    const text = `before ${SECRET} after`;
    for (const size of [1, 3, 7]) {
      const st = registry.createStream(T, 'r1');
      let out = '';
      for (let i = 0; i < text.length; i += size) out += st.push(text.slice(i, i + size));
      out += st.flush();
      expect(out).toBe('before ***REDACTED:db*** after');
    }
    expect(s.push('plain')).not.toContain(SECRET);
  });

  it('never emits a partial secret mid-stream', async () => {
    const { registry } = setup();
    await registry.register(T, 'r1', { label: 'db', value: SECRET });
    const st = registry.createStream(T, 'r1');
    const first = st.push(`xx ${SECRET.slice(0, 6)}`);
    expect(first).not.toContain(SECRET.slice(0, 4));
  });

  it('purges on run kill and no longer matches', async () => {
    const { registry, audits } = setup();
    await registry.register(T, 'r1', { label: 'db', value: SECRET });
    await registry.onRunState(T, 'r1', 'running');
    expect(registry.has(T, 'r1')).toBe(true);
    await registry.onRunState(T, 'r1', 'killed');
    expect(registry.has(T, 'r1')).toBe(false);
    expect(registry.redact(T, 'r1', SECRET)).toEqual({ text: SECRET, hits: 0, truncated: false });
    expect(audits.map((a) => a.action)).toEqual([
      'secret.redaction_registry_created',
      'secret.redaction_registry_purged',
    ]);
    for (const state of ['completed', 'failed']) {
      await registry.register(T, 'r2', { label: 'db', value: SECRET });
      await registry.onRunState(T, 'r2', state);
      expect(registry.has(T, 'r2')).toBe(false);
    }
  });

  it('drops the literals even when the purge audit fails', async () => {
    const registry = createRedactionRegistry({
      audit: (e) =>
        e.action === 'secret.redaction_registry_purged'
          ? Promise.reject(new Error('down'))
          : Promise.resolve(),
    });
    await registry.register(T, 'r1', { label: 'db', value: SECRET });
    await expect(registry.purge(T, 'r1')).rejects.toThrow('down');
    expect(registry.has(T, 'r1')).toBe(false);
  });

  it('does not create a registry when its audit fails', async () => {
    const registry = createRedactionRegistry({ audit: () => Promise.reject(new Error('down')) });
    await expect(registry.register(T, 'r1', { label: 'db', value: SECRET })).rejects.toThrow(
      'down',
    );
    expect(registry.has(T, 'r1')).toBe(false);
  });

  it('isolates runs and tenants', async () => {
    const { registry } = setup();
    await registry.register(T, 'run-a', { label: 'db', value: SECRET });
    expect(registry.redact(T, 'run-b', SECRET).hits).toBe(0);
    expect(registry.redact('tenant-b', 'run-a', SECRET).hits).toBe(0);
    await registry.purge(T, 'run-b');
    expect(registry.redact(T, 'run-a', SECRET).hits).toBe(1);
  });

  it('rejects ids that could address another key', async () => {
    const { registry } = setup();
    await expect(
      registry.register(T, 'r1:redaction', { label: 'x', value: SECRET }),
    ).rejects.toThrow();
    await expect(registry.register('a*', 'r1', { label: 'x', value: SECRET })).rejects.toThrow();
    await expect(
      registry.register(T, 'r1', { label: 'Bad Label', value: SECRET }),
    ).rejects.toThrow();
  });

  it('keeps redacting a rotated-out value until the grace period ends', async () => {
    const { registry, clock } = setup({ graceMs: 5_000 });
    const next = 'Nw3$kP8!cVb6Hs1d';
    await registry.register(T, 'r1', { label: 'sess', value: SECRET });
    await registry.rotate(T, 'r1', { label: 'sess', value: next });
    expect(registry.redact(T, 'r1', `${SECRET} ${next}`).hits).toBe(2);
    clock.t += 5_001;
    expect(registry.redact(T, 'r1', `${SECRET} ${next}`).text).toBe(
      `${SECRET} ***REDACTED:sess***`,
    );
    expect(registry.size(T, 'r1')).toBe(1);
  });

  it('removes a value immediately', async () => {
    const { registry } = setup();
    await registry.register(T, 'r1', { label: 'sess', value: SECRET });
    registry.remove(T, 'r1', 'sess');
    expect(registry.redact(T, 'r1', SECRET).hits).toBe(0);
  });

  it('truncates huge input without half-emitting a straddling secret', async () => {
    const { registry } = setup({ maxScanChars: 20 });
    await registry.register(T, 'r1', { label: 'db', value: SECRET });
    const res = registry.redact(T, 'r1', `${'x'.repeat(15)}${SECRET}${'y'.repeat(50)}`);
    expect(res.truncated).toBe(true);
    expect(res.text).toBe(`${'x'.repeat(15)}***REDACTED:db******TRUNCATED***`);
  });

  it('keeps plaintext out of audit events and metrics', async () => {
    const { registry, audits, hitCalls } = setup();
    await registry.register(T, 'r1', { label: 'db', value: SECRET });
    registry.redact(T, 'r1', SECRET);
    await registry.purge(T, 'r1');
    const dump = JSON.stringify([audits, hitCalls]);
    expect(dump).not.toContain(SECRET);
    expect(audits[1]?.metadata).toEqual({ values: 1, hits: 1 });
  });

  it('withholds text when the registry is unavailable (fail closed)', () => {
    let failed = 0;
    const res = redactFailClosed(
      () => {
        throw new Error('valkey down');
      },
      { failClosed: () => failed++ },
    );
    expect(res.text).not.toContain('valkey');
    expect(res.text).toBe('***WITHHELD:redaction-unavailable***');
    expect(failed).toBe(1);
  });
});
