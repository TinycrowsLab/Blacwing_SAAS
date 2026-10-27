import { describe, expect, it, vi } from 'vitest';

import { parsePersonaDefinition } from '@blackwing/agents';

import {
  checkCompletion,
  type CompletionCheckedEvent,
  type DeliverableKind,
  type DeliverableReader,
  type StopCheckPorts,
} from './stop.js';

function persona(
  requiresSubmission: boolean,
  name: 'web-api-specialist' | 'reflector' = 'web-api-specialist',
) {
  return parsePersonaDefinition({
    name,
    mandate: 'Test the subtask and submit the result.',
    tierAlias: 'deep',
    effort: 'high',
    maxTurns: 40,
    maxBudgetUsdDefault: 5,
    allowedTools: ['Read'],
    disallowedTools: ['WebFetch', 'WebSearch'],
    declaredOracleTypes: [],
    inputs: ['subtask'],
    intrusivenessCeiling: 'passive',
    requiresSubmission,
    promptRef: { persona: name, version: '1.0.0' },
    guardrails: { scopeEnforced: true, treatToolOutputAsUntrusted: true },
  });
}

function readerReturning(kinds: readonly DeliverableKind[]): DeliverableReader {
  return { submittedKinds: vi.fn(() => Promise.resolve(kinds)) };
}

function readerFailing(error: Error): DeliverableReader {
  return { submittedKinds: vi.fn(() => Promise.reject(error)) };
}

function ports(deliverables: DeliverableReader) {
  const events: CompletionCheckedEvent[] = [];
  const incomplete: string[] = [];
  const logged: Record<string, string>[] = [];
  const p: StopCheckPorts = {
    deliverables,
    audit: { record: (event) => void events.push(event) },
    metrics: { incIncompleteSession: (name) => void incomplete.push(name) },
    log: { info: (fields) => void logged.push(fields) },
  };
  return { p, events, incomplete, logged };
}

const input = (p: ReturnType<typeof persona>) => ({
  persona: p,
  sessionId: 'sess-1',
  subtaskId: 'sub-42',
});

describe('Stop hook completion check', () => {
  it('completes a specialist session that submitted a candidate', async () => {
    const { p, events, incomplete } = ports(readerReturning(['candidate']));

    const outcome = await checkCompletion(input(persona(true)), p);

    expect(outcome).toEqual({ completion: 'complete', failureCode: null });
    expect(events).toEqual([
      {
        action: 'session.completion_checked',
        sessionId: 'sess-1',
        subtaskId: 'sub-42',
        persona: 'web-api-specialist',
        result: 'complete',
      },
    ]);
    expect(incomplete).toEqual([]);
  });

  it('accepts a structured output or a no_findings marker as the deliverable', async () => {
    for (const kind of ['structured_output', 'no_findings'] as const) {
      const { p } = ports(readerReturning([kind]));
      expect((await checkCompletion(input(persona(true)), p)).completion).toBe('complete');
    }
  });

  it('is satisfied when any one of several deliverables was submitted', async () => {
    const { p } = ports(readerReturning(['no_findings', 'candidate']));
    expect((await checkCompletion(input(persona(true)), p)).completion).toBe('complete');
  });

  it('marks a specialist session with no deliverable incomplete, mapped to result_not_submitted', async () => {
    const { p, events, incomplete, logged } = ports(readerReturning([]));

    const outcome = await checkCompletion(input(persona(true)), p);

    expect(outcome).toEqual({ completion: 'incomplete', failureCode: 'result_not_submitted' });
    expect(events.map((e) => e.result)).toEqual(['incomplete']);
    expect(incomplete).toEqual(['web-api-specialist']);
    expect(logged).toEqual([
      {
        subtaskId: 'sub-42',
        sessionId: 'sess-1',
        persona: 'web-api-specialist',
        completion: 'incomplete',
      },
    ]);
  });

  it('exempts a read-only persona without asking the broker', async () => {
    const submittedKinds = vi.fn(() => Promise.resolve<readonly DeliverableKind[]>([]));
    const { p, events, incomplete } = ports({ submittedKinds });

    const outcome = await checkCompletion(input(persona(false, 'reflector')), p);

    expect(outcome).toEqual({ completion: 'exempt', failureCode: null });
    expect(submittedKinds).not.toHaveBeenCalled();
    expect(events.map((e) => e.result)).toEqual(['exempt']);
    expect(incomplete).toEqual([]);
  });

  it('fails closed to incomplete when the broker is unreachable', async () => {
    const { p, events, incomplete } = ports(
      readerFailing(new Error('ECONNREFUSED broker:8443 token=abc')),
    );

    const outcome = await checkCompletion(input(persona(true)), p);

    expect(outcome).toEqual({ completion: 'incomplete', failureCode: 'result_not_submitted' });
    expect(events.map((e) => e.result)).toEqual(['incomplete']);
    expect(incomplete).toEqual(['web-api-specialist']);
  });

  it('fails closed to incomplete on a malformed broker response', async () => {
    const malformed: DeliverableReader[] = [
      { submittedKinds: () => Promise.resolve('candidate' as unknown as DeliverableKind[]) },
      { submittedKinds: () => Promise.resolve(['shell_output'] as unknown as DeliverableKind[]) },
      { submittedKinds: () => Promise.resolve(null as unknown as DeliverableKind[]) },
    ];
    for (const reader of malformed) {
      const { p } = ports(reader);
      expect((await checkCompletion(input(persona(true)), p)).completion).toBe('incomplete');
    }
  });

  it('reads the required-deliverable rule from the persona definition flag', async () => {
    const withFlag = ports(readerReturning([]));
    const withoutFlag = ports(readerReturning([]));

    expect((await checkCompletion(input(persona(true)), withFlag.p)).completion).toBe('incomplete');
    expect((await checkCompletion(input(persona(false)), withoutFlag.p)).completion).toBe('exempt');
  });

  it('rejects when the audit record cannot be written, so a stop never finishes unaudited', async () => {
    const { p } = ports(readerReturning(['candidate']));
    const failingAudit = { ...p, audit: { record: () => Promise.reject(new Error('audit down')) } };

    await expect(checkCompletion(input(persona(true)), failingAudit)).rejects.toThrow('audit down');
  });
});
