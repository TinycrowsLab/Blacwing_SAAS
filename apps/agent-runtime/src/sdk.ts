import { query } from '@anthropic-ai/claude-agent-sdk';

import type { RunQuery } from './session/run-session.js';

/**
 * The pinned Claude Agent SDK version (CONTEXT_PACK §4, §8.9). `sdk.test.ts` asserts it matches the installed
 * package, so a bump cannot drift from what the runtime records.
 */
export const SDK_VERSION = '0.3.308';

/**
 * The production `RunQuery`: drives the SDK's `query()` and keeps only the result messages the runner reads.
 * The SDK's own message types stay inside this adapter.
 */
export const runSdkQuery: RunQuery = async function* runSdkQuery({ prompt, options }) {
  for await (const message of query({ prompt, options })) {
    if (message.type === 'result') {
      yield {
        type: 'result',
        subtype: message.subtype,
        num_turns: message.num_turns,
        total_cost_usd: message.total_cost_usd,
        modelUsage: message.modelUsage,
      };
    }
  }
};
