import { describe, expect, it } from 'vitest';

import {
  EXPOSURE_MATRIX,
  exposureClassOf,
  exposureViolations,
  READ_ONLY_PERSONAS,
  TARGET_MANDATE_PERSONAS,
  TOOL_EXPOSURE_CLASSES,
} from './exposure.js';

const rows = Object.entries(EXPOSURE_MATRIX) as [string, readonly string[]][];
const usedTools = new Set(rows.flatMap(([, tools]) => tools));

describe('EXPOSURE_MATRIX structure', () => {
  it.each(rows)('%s: has no duplicate entries', (_persona, tools) => {
    expect(new Set(tools).size).toBe(tools.length);
  });

  it.each(rows)('%s: every entry is classified', (_persona, tools) => {
    for (const tool of tools) {
      expect(exposureClassOf(tool), tool).toBeDefined();
    }
  });

  it('never lists a networked built-in in any row', () => {
    for (const [, tools] of rows) {
      expect(tools).not.toContain('WebFetch');
      expect(tools).not.toContain('WebSearch');
    }
  });

  it('classifies only entries that some row uses (no stale classes)', () => {
    for (const tool of Object.keys(TOOL_EXPOSURE_CLASSES)) {
      expect(usedTools.has(tool), tool).toBe(true);
    }
  });

  it('keeps wildcards to a server or external prefix', () => {
    const wildcards = [...usedTools].filter((tool) => tool.endsWith('*'));
    expect(wildcards.filter((tool) => !/^mcp__[a-z][a-z0-9_]*__\*$/.test(tool))).toEqual([]);
  });

  it('only names mandate personas that exist in the matrix', () => {
    const personas = new Set(rows.map(([persona]) => persona));
    for (const persona of [...READ_ONLY_PERSONAS, ...TARGET_MANDATE_PERSONAS]) {
      expect(personas.has(persona), persona).toBe(true);
    }
  });
});

describe('exposureViolations', () => {
  it('accepts every matrix row for its own persona', () => {
    for (const [persona, tools] of rows) {
      expect(exposureViolations(persona, tools), persona).toEqual([]);
    }
  });

  it('rejects networked built-ins for every persona', () => {
    for (const [persona] of rows) {
      expect(exposureViolations(persona, ['WebFetch'])).toHaveLength(1);
      expect(exposureViolations(persona, ['WebSearch'])).toHaveLength(1);
    }
  });

  it('fails closed on an unclassified tool', () => {
    expect(exposureViolations('reporter', ['mcp__blackwing_new__tool'])).toEqual([
      'mcp__blackwing_new__tool is not classified in the exposure matrix',
    ]);
  });

  it('rejects a target tool for a persona without target mandate', () => {
    expect(exposureViolations('orchestrator', ['mcp__blackwing__http_request'])).toHaveLength(1);
    expect(exposureViolations('osint', ['mcp__blackwing_target__tcp_probe'])).toHaveLength(1);
  });

  it('allows a target tool for a persona with target mandate', () => {
    expect(
      exposureViolations('web-api-specialist', ['mcp__blackwing_target__http_request']),
    ).toEqual([]);
  });

  it('rejects a non-read-only tool for a read-only persona', () => {
    expect(
      exposureViolations('validator-assistant', ['mcp__blackwing_findings__submit_candidate']),
    ).toHaveLength(1);
    expect(exposureViolations('mentor', ['Bash'])).toContainEqual(
      expect.stringContaining('read-only'),
    );
  });

  it('accepts read-only tools for a read-only persona', () => {
    expect(
      exposureViolations('reporter', ['mcp__blackwing_findings__finding_read', 'Read']),
    ).toEqual([]);
  });
});
