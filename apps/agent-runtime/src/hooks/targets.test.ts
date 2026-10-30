import { describe, expect, it } from 'vitest';

import { PDP_TARGETS_MAX } from '@blackwing/contracts';

import { extractTargets } from './targets.js';

const targets = (toolName: string, input: unknown): readonly string[] | 'unresolved' => {
  const result = extractTargets(toolName, input);
  return result.kind === 'unresolved' ? 'unresolved' : result.targets;
};
const bash = (command: string) => ({ command });

describe('extractTargets (RUNTIME-005)', () => {
  it('keeps the origin and path of a URL and drops its query, fragment and credentials', () => {
    expect(
      targets(
        'Bash',
        bash('curl "https://user:s3cret@lab.example.test:8443/login?token=abc#frag"'),
      ),
    ).toEqual(['https://lab.example.test:8443/login']);
  });

  it('reads IPv4 literals and does not match a version-like number as an address', () => {
    expect(targets('Bash', bash('nmap 10.20.1.5 && echo v1.2.3'))).toEqual(['10.20.1.5']);
  });

  it('names no target for a local command with no network tool', () => {
    expect(targets('Bash', bash('cat notes.txt && ls -la'))).toEqual([]);
  });

  it('reads hostname words only when a network command runs', () => {
    expect(targets('Bash', bash('dig +short api.lab.example.test'))).toEqual([
      'api.lab.example.test',
    ]);
    expect(targets('Bash', bash('/usr/bin/curl -s Other.Example.Test'))).toEqual([
      'other.example.test',
    ]);
  });

  it('marks a network command with no resolvable target as unresolved (fail closed)', () => {
    expect(targets('Bash', bash('curl -s --help'))).toBe('unresolved');
  });

  it('marks a Bash call whose input has no command string as unresolved', () => {
    expect(targets('Bash', { cmd: 'ls' })).toBe('unresolved');
    expect(targets('Bash', 'ls')).toBe('unresolved');
  });

  it('marks a URL that does not parse as unresolved', () => {
    expect(targets('Bash', bash('curl https://'))).toBe('unresolved');
  });

  it('reads an MCP call from its target fields only, and redacts a URL there too', () => {
    expect(
      targets('mcp__recon__probe', {
        url: 'https://lab.example.test/a?key=1',
        host: '10.20.1.5',
        unrelated: 'https://elsewhere.example.test',
        port: 443,
      }),
    ).toEqual(['https://lab.example.test/a', '10.20.1.5']);
  });

  it('returns no targets for an MCP call without target fields, and for an empty input', () => {
    expect(targets('mcp__engagement__get_state', {})).toEqual([]);
    expect(targets('mcp__engagement__get_state', null)).toEqual([]);
  });

  it('marks a call with more targets than the PDP accepts as unresolved, never partial', () => {
    const hosts = Array.from(
      { length: PDP_TARGETS_MAX + 1 },
      (_v, i) => `10.20.1.${String(i + 1)}`,
    );
    expect(targets('Bash', bash(hosts.join(' ')))).toBe('unresolved');
    expect(targets('Bash', bash(hosts.slice(0, PDP_TARGETS_MAX).join(' ')))).toHaveLength(
      PDP_TARGETS_MAX,
    );
  });
});
