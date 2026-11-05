import { describe, expect, it } from 'vitest';

import { EventLog } from './context.js';
import { FakeStore } from './fake-store.js';
import { MessageRouter } from './messages.js';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

function assistant(parent: string | null, content: unknown[], tokens = 10): SDKMessage {
  // Only the fields the router reads are provided.
  return { type: 'assistant', parent_tool_use_id: parent, message: { content, usage: { input_tokens: tokens, output_tokens: 0 } } } as unknown as SDKMessage;
}

describe('MessageRouter', () => {
  it('attributes subagent messages to the lane named in the Agent tool call', async () => {
    const store = new FakeStore();
    const router = new MessageRouter(new EventLog(store, 'r', 1, { warn: () => undefined, error: () => undefined }));
    await router.handle(assistant(null, [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'recon', description: 'map it' } }]));
    await router.handle(assistant('tu1', [{ type: 'text', text: 'checking robots.txt' }, { type: 'tool_use', id: 'h1', name: 'mcp__blackwing__http_request', input: {} }], 30));
    await router.handle(assistant('tu1', [{ type: 'tool_use', id: 's1', name: 'mcp__blackwing__list_exchanges', input: {} }], 10));
    router.setTotalCost(0.4);
    await router.handle(assistant(null, [{ type: 'text', text: 'summary' }], 10));

    expect(store.events.map((e) => [e.kind, e.data.agent])).toEqual([
      ['agent.tool', 'orchestrator'],
      ['agent.turn', 'orchestrator'],
      ['agent.message', 'recon'],
      ['agent.turn', 'recon'],
      ['agent.tool', 'recon'],
      ['agent.turn', 'recon'],
      ['agent.message', 'orchestrator'],
      ['agent.turn', 'orchestrator'],
    ]);
    expect(store.events[0]?.data).toMatchObject({ tool: 'Agent', input: { subagent: 'recon', description: 'map it' } });
    expect(store.events[4]?.data).toMatchObject({ tool: 'list_exchanges' });
    // recon has 40 of 60 tokens, 2 turns; orchestrator 20 of 60, 2 turns
    expect(store.events.at(-1)?.data).toEqual({ agent: 'orchestrator', turns: 2, costUsd: 0.1333 });
    expect(store.events.at(-3)?.data).toMatchObject({ agent: 'recon', turns: 2 });
  });

  it('ignores non-assistant messages', async () => {
    const store = new FakeStore();
    const router = new MessageRouter(new EventLog(store, 'r', 1, { warn: () => undefined, error: () => undefined }));
    await router.handle({ type: 'result' } as unknown as SDKMessage);
    expect(store.events).toEqual([]);
  });
});
