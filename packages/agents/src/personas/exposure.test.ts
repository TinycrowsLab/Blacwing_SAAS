import { describe, expect, it } from 'vitest';

import { EXPOSURE_MATRIX, exposureViolations } from '@blackwing/mcp-tools';

import {
  FORBIDDEN_BUILTIN_TOOLS,
  loadPersona,
  PERSONA_NAMES,
  type PersonaName,
} from '../persona.js';

import './index.js';

/**
 * REGISTRY ↔ exposure matrix (MCP-015, #680). The matrix in `@blackwing/mcp-tools` is the single source of each
 * persona's `allowedTools`; these tests fail CI when a persona definition, the matrix or a mandate drifts.
 */
describe('exposure matrix covers the persona roster', () => {
  it('has exactly one row per persona (19)', () => {
    expect(PERSONA_NAMES).toHaveLength(19);
    expect(Object.keys(EXPOSURE_MATRIX).sort()).toEqual([...PERSONA_NAMES].sort());
  });
});

describe.each(PERSONA_NAMES.map((name) => [name] as const))('%s', (name: PersonaName) => {
  const row: readonly string[] = EXPOSURE_MATRIX[name];
  const def = loadPersona(name);

  it("allowedTools equals the persona's matrix row", () => {
    expect(def.allowedTools).toEqual([...row]);
  });

  it('exposes no networked built-in', () => {
    for (const t of FORBIDDEN_BUILTIN_TOOLS) {
      expect(row).not.toContain(t);
      expect(def.allowedTools).not.toContain(t);
    }
  });

  it('exposes only classified tools within its mandate', () => {
    expect(exposureViolations(name, def.allowedTools)).toEqual([]);
  });

  it('helpers inherit only within the parent row', () => {
    for (const helper of def.helpers ?? []) {
      const outside = helper.allowedTools.filter((t) => !def.allowedTools.includes(t));
      expect(outside, `${helper.name} outside ${name}`).toEqual([]);
    }
  });
});

describe('drift and mandate negatives', () => {
  it('a target tool added to a read-only persona is a violation', () => {
    const drifted = [...EXPOSURE_MATRIX.reporter, 'mcp__blackwing_target__http_request'];
    expect(exposureViolations('reporter', drifted)).toContainEqual(
      expect.stringContaining('no mandate'),
    );
  });

  it('a web built-in added to any persona is a violation', () => {
    for (const name of PERSONA_NAMES) {
      expect(exposureViolations(name, [...EXPOSURE_MATRIX[name], 'WebSearch'])).not.toEqual([]);
    }
  });
});
