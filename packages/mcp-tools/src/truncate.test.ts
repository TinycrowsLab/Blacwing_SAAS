import { describe, expect, it } from 'vitest';

import { limitOutput } from './truncate.js';

const sink = (id = 'ev-123') => {
  const stored: string[] = [];
  return {
    stored,
    store: (input: { content: string }) => {
      stored.push(input.content);
      return Promise.resolve(id);
    },
  };
};

describe('limitOutput', () => {
  it('returns output within the limit unchanged and stores nothing', async () => {
    const evidence = sink();
    const out = await limitOutput('hello', 1024, evidence, 'd');
    expect(out).toEqual({ text: 'hello', bytes: 5, truncated: false });
    expect(evidence.stored).toHaveLength(0);
  });

  it('measures bytes, not characters', async () => {
    const evidence = sink();
    const text = 'é'.repeat(600); // 1200 bytes
    expect((await limitOutput(text, 1024, evidence, 'd')).truncated).toBe(true);
  });

  it('stores the full output and returns head, tail and an evidence pointer', async () => {
    const evidence = sink();
    const text = `START${'x'.repeat(200_000)}END`;
    const out = await limitOutput(text, 131_072, evidence, 'd');
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBe(200_008);
    expect(evidence.stored).toEqual([text]);
    expect(parsed).toMatchObject({
      ok: true,
      truncated: true,
      evidence: 'evidence://ev-123',
      totalBytes: 200_008,
    });
    expect(String(parsed.head).startsWith('START')).toBe(true);
    expect(String(parsed.tail).endsWith('END')).toBe(true);
    expect(Buffer.byteLength(out.text)).toBeLessThan(131_072);
  });

  it('never splits a multi-byte character at either cut', async () => {
    const text = '😀'.repeat(5000) + '日本語'.repeat(5000);
    for (const max of [1024, 1025, 1026, 1027, 4099]) {
      const out = await limitOutput(text, max, sink(), 'd');
      const parsed = JSON.parse(out.text) as { head: string; tail: string };
      expect(parsed.head).not.toContain('�');
      expect(parsed.tail).not.toContain('�');
      expect(text.startsWith(parsed.head)).toBe(true);
      expect(text.endsWith(parsed.tail)).toBe(true);
    }
  });

  it('fails closed when evidence cannot be stored', async () => {
    const failing = { store: () => Promise.reject(new Error('disk full /secret/path')) };
    await expect(limitOutput('x'.repeat(2000), 1024, failing, 'd')).rejects.toMatchObject({
      code: 'TOOL_BACKEND_UNAVAILABLE',
      message: expect.not.stringContaining('/secret/path') as unknown,
    });
  });

  it.each(['', 'a/b', 'x y', '../x', 'a'.repeat(200)])('rejects the evidence id %j', async (id) => {
    await expect(limitOutput('x'.repeat(2000), 1024, sink(id), 'd')).rejects.toMatchObject({
      code: 'TOOL_BACKEND_UNAVAILABLE',
    });
  });
});
