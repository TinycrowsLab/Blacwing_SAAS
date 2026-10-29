import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SDK_VERSION } from './sdk.js';

describe('SDK_VERSION', () => {
  it('matches the installed, exactly pinned Claude Agent SDK', () => {
    const installed = JSON.parse(
      readFileSync(
        new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string };
    expect(SDK_VERSION).toBe(installed.version);
  });
});
