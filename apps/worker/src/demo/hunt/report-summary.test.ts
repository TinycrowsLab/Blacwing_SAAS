import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventLog } from './context.js';
import { FakeStore } from './fake-store.js';
import { buildSummaryInput, generateReportSummary, type SummaryFacts } from './report-summary.js';

import type { HuntRun, SummaryFinding } from './types.js';

const queryMock = vi.hoisted(() => vi.fn<(arg: { options: Record<string, unknown> }) => AsyncIterable<unknown>>());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const run = { id: 'r1', assetName: 'Shop', budgetRequests: 100, budgetSeconds: 600, costCapUsd: 5 } as unknown as HuntRun;
const logger = { warn: vi.fn(), error: vi.fn() };
const facts: SummaryFacts = {
  state: 'stopped',
  endReason: 'request_budget',
  requestsUsed: 100,
  costUsd: 1.234,
  intel: { skipped: null, items: [{ severity: 'high', basis: 'observed' }], discoveredHosts: ['a.example.com'] },
  coverage: [{ title: 'SQLi', status: 'executed' }, { title: 'Upload', status: 'not_run' }],
};
const finding = (over: Partial<SummaryFinding> = {}): SummaryFinding => ({ title: 'Reflected XSS', severity: 'high', cwe: 'CWE-79', owasp: 'A03', status: 'released', location: 'GET https://x.test/s', remediation: 'Encode output', ...over });
const config = { model: 'm1', fallbackModel: 'm2', effort: 'medium' as const };

function mockReply(text: string): void {
  queryMock.mockImplementation(() => (function* () { yield { type: 'result', subtype: 'success', result: text }; })() as unknown as AsyncIterable<unknown>);
}
function setup(findings: SummaryFinding[]): { store: FakeStore; log: EventLog; events: { kind: string; data: Record<string, unknown> }[] } {
  const store = new FakeStore();
  store.listFindingsForSummary = () => Promise.resolve(findings);
  return { store, log: new EventLog(store, 'r1', logger), events: store.events };
}

describe('report summary', () => {
  beforeEach(() => { queryMock.mockReset(); });

  it('sends only verified, scrubbed fields', () => {
    const input = buildSummaryInput(run, [finding({ remediation: 'token=sk-ant-abcdefghijklmnopqrstuvwxyz123456 rotate' }), finding({ title: 'Maybe SQLi', status: 'suspected' })], facts);
    expect(input).toContain('Proven findings (1)');
    expect(input).toContain('Kept back, suspected and NOT proven: 1');
    expect(input).not.toContain('Maybe SQLi');
    expect(input).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz123456');
    expect(input).toContain('Upload (not_run)');
    expect(input).toContain('100 of 100 requests');
  });

  it('makes one tool-less call and stores report.summary', async () => {
    mockReply('## Executive summary\nRisk is high.\n\n## Key risks\n- XSS\n\n## Recommended next steps\n1. Fix');
    const { store, log, events } = setup([finding()]);
    await generateReportSummary(store, run, log, logger, config, {}, facts);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const opts = queryMock.mock.calls[0]?.[0].options;
    expect(opts).toMatchObject({ model: 'm1', fallbackModel: 'm2', effort: 'medium', tools: [], maxTurns: 1 });
    const ev = events.find((e) => e.kind === 'report.summary');
    expect(ev?.data).toMatchObject({ model: 'm1' });
    expect(String(ev?.data.markdown)).toContain('Executive summary');
  });

  it('is skipped when disabled and swallows errors', async () => {
    const { store, log, events } = setup([finding()]);
    await generateReportSummary(store, run, log, logger, { ...config, summary: false }, {}, facts);
    expect(queryMock).not.toHaveBeenCalled();
    queryMock.mockImplementation(() => { throw new Error('boom'); });
    await expect(generateReportSummary(store, run, log, logger, config, {}, facts)).resolves.toBeUndefined();
    expect(events.some((e) => e.kind === 'report.summary')).toBe(false);
  });

  it('gives up after the timeout', async () => {
    queryMock.mockImplementation(() => (async function* () { await new Promise(() => undefined); yield {}; })());
    const { store, log, events } = setup([]);
    await generateReportSummary(store, run, log, logger, config, {}, facts, 20);
    expect(events.some((e) => e.kind === 'report.summary')).toBe(false);
  });
});
