import { describe, expect, it } from 'vitest';

import { agentInitials, agentName } from './agents';

describe('agents', () => {
  it('maps ids to plain names and leaves unknown ids as they are', () => {
    expect(agentName('orchestrator')).toBe('Planner');
    expect(agentName('authz-specialist')).toBe('Access control specialist');
    expect(agentName('general-purpose')).toBe('General helper');
    expect(agentName('new-agent')).toBe('new-agent');
    expect(agentInitials('web-api-specialist')).toBe('WA');
    expect(agentInitials('zeta')).toBe('ZE');
  });
});
