// The repository `.env.example` must boot the gateway config, on the fixed dev port, pointed at a local
// upstream only (offline-first: never a real provider by default).
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadGatewayConfig } from './config.js';

function exampleEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) out[match[1]] = match[2] ?? '';
  }
  return out;
}

describe('.env.example vs the gateway config', () => {
  it('loads with no validation errors on the dev port and a loopback upstream', () => {
    const config = loadGatewayConfig({ ...exampleEnv(), NODE_ENV: 'test' });
    expect(config.GATEWAY_PORT).toBe(13_500);
    expect(new URL(config.GATEWAY_ANTHROPIC_BASE_URL).hostname).toBe('127.0.0.1');
    expect(config.GATEWAY_ANTHROPIC_API_KEY).toBeUndefined();
  });
});
