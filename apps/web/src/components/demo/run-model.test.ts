import { describe as suite, expect, it } from 'vitest';

import { agentLanes, candidates, describe, killConfirmed, mmss, secondsLeft } from './run-model';

import type { DemoRunEvent } from '../../app/demo/_lib/schemas';

const ev = (
  seq: number,
  kind: string,
  stage: string,
  data: Record<string, unknown>,
): DemoRunEvent => ({
  seq,
  kind,
  stage,
  message: '',
  data,
  at: '2026-11-05T10:00:00.000Z',
});

suite('kill confirmation', () => {
  const runId = '0194ab12-3456-7890-abcd-ef0123456789';
  it('accepts the first 8 characters, any case', () => {
    expect(killConfirmed('0194AB12', runId)).toBe(true);
    expect(killConfirmed(' 0194ab12 ', runId)).toBe(true);
  });
  it('refuses anything else', () => {
    expect(killConfirmed('', runId)).toBe(false);
    expect(killConfirmed('0194ab1', runId)).toBe(false);
    expect(killConfirmed(runId, runId)).toBe(false);
  });
});

suite('gate 2 countdown', () => {
  const deadline = '2026-11-05T10:05:00.000Z';
  it('counts down and never goes negative (expired means denied)', () => {
    expect(secondsLeft(deadline, Date.parse('2026-11-05T10:00:00.000Z'))).toBe(300);
    expect(secondsLeft(deadline, Date.parse('2026-11-05T10:05:01.000Z'))).toBe(0);
  });
  it('formats mm:ss', () => {
    expect(mmss(398)).toBe('06:38');
    expect(mmss(-4)).toBe('00:00');
  });
});

suite('event mapping', () => {
  it('marks blocked requests as errors with a ring', () => {
    const row = describe(
      ev(1, 'policy.blocked', 'policy', {
        agent: 'recon',
        method: 'DELETE',
        url: 'https://a.example/x',
        rule: 'destructive',
      }),
    );
    expect(row).toMatchObject({ kind: 'Policy', isError: true, mark: 'ring', agent: 'recon' });
  });
  it('flags http errors and ignores agent.turn rows', () => {
    expect(
      describe(
        ev(2, 'http.sent', 'recon', {
          agent: 'recon',
          method: 'GET',
          url: 'https://a.example/p?q=1',
          status: 500,
          bytes: 3,
          ms: 9,
        }),
      )?.isError,
    ).toBe(true);
    expect(
      describe(ev(3, 'agent.turn', 'recon', { agent: 'recon', turns: 1, costUsd: 0.1 })),
    ).toBeNull();
  });
  it('builds lanes with the latest turn totals', () => {
    const lanes = agentLanes([
      ev(1, 'run.started', 'plan', { model: 'm', agents: ['orchestrator', 'recon'] }),
      ev(2, 'agent.turn', 'recon', { agent: 'recon', turns: 2, costUsd: 0.1 }),
      ev(3, 'agent.turn', 'recon', { agent: 'recon', turns: 5, costUsd: 0.3 }),
    ]);
    expect(lanes.map((l) => l.name)).toEqual(['orchestrator', 'recon']);
    expect(lanes[1]).toMatchObject({ turns: 5, costUsd: 0.3 });
  });
  it('tracks a candidate from submission to confirmation', () => {
    const list = candidates([
      ev(1, 'candidate.submitted', 'validator', {
        agent: 'recon',
        candidateId: 'c1',
        title: 'T',
        severity: 'high',
      }),
      ev(2, 'validator.replay', 'validator', {
        candidateId: 'c1',
        n: 2,
        status: 200,
        matched: true,
      }),
    ]);
    expect(list[0]).toMatchObject({ status: 'validating', replays: 2 });
    const done = candidates([
      ev(1, 'candidate.submitted', 'validator', {
        agent: 'recon',
        candidateId: 'c1',
        title: 'T',
        severity: 'high',
      }),
      ev(3, 'finding.confirmed', 'validator', {
        candidateId: 'c1',
        findingId: 'f1',
        title: 'T',
        severity: 'high',
      }),
    ]);
    expect(done[0]).toMatchObject({ status: 'confirmed', findingId: 'f1' });
  });
});
