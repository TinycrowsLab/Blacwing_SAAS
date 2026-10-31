import { describe, expect, it } from 'vitest';

import { SELECTABLE_INTRUSIVENESS_CLASSES } from '@blackwing/contracts';

import {
  TEMPLATE_CLASSES,
  TestCaseLibraryError,
  templateCountsByClass,
  templatesForMode,
  validateTemplateLibrary,
} from './template.js';

/** A valid, mid-risk template. Each negative case below changes one field of it. */
const base = {
  templateId: 'athz-04-object-reference-access',
  class: 'active_safe',
  defaultOracleType: 'access_matrix',
  defaultNegativeControl: 'alternate_role',
  owaspRefs: ['A01', 'API1'],
  wstgRefs: ['WSTG-ATHZ-04'],
  asvsRefs: ['v5.0.0-8.2.2'],
  cweCandidates: ['CWE-639'],
  applicableModes: ['black', 'grey', 'white'],
  defaultBudgetProfile: 'medium',
  specialistPersona: 'auth-logic-specialist',
};

/** Validates a raw list and returns the issue lines, or an empty list when it is valid. */
function issuesOf(raw: readonly unknown[]): string[] {
  try {
    validateTemplateLibrary(raw);
  } catch (error) {
    if (error instanceof TestCaseLibraryError) return [...error.issues];
    throw error;
  }
  return [];
}

/** The issues for one template with one field changed. */
const issuesWith = (changes: Record<string, unknown>): string[] =>
  issuesOf([{ ...base, ...changes }]);

describe('test-case template schema (PLANNER-002)', () => {
  it('accepts a complete, valid template and returns it parsed', () => {
    const parsed = validateTemplateLibrary([base]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(base);
  });

  it('pins the class literal list to the contracts selectable classes', () => {
    expect([...TEMPLATE_CLASSES]).toEqual([...SELECTABLE_INTRUSIVENESS_CLASSES]);
  });

  describe('negative cases fail with the path that is wrong', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['the destructive class (never runs, §8.3)', { class: 'destructive' }, 'class'],
      ['an unknown class', { class: 'aggressive' }, 'class'],
      ['an uppercase template id', { templateId: 'ATHZ-04' }, 'templateId'],
      ['a too-short template id', { templateId: 'ab' }, 'templateId'],
      ['an unknown oracle type', { defaultOracleType: 'blind_magic' }, 'defaultOracleType'],
      [
        'an unknown negative-control kind',
        { defaultNegativeControl: 'random' },
        'defaultNegativeControl',
      ],
      ['an OWASP id outside the Top 10 and API Top 10', { owaspRefs: ['A11'] }, 'owaspRefs'],
      ['an API id above API10', { owaspRefs: ['API11'] }, 'owaspRefs'],
      ['no OWASP ref at all', { owaspRefs: [] }, 'owaspRefs'],
      ['a malformed WSTG id', { wstgRefs: ['WSTG-ATHZ-4'] }, 'wstgRefs'],
      ['an unknown WSTG category', { wstgRefs: ['WSTG-XXXX-04'] }, 'wstgRefs'],
      ['an empty WSTG list', { wstgRefs: [] }, 'wstgRefs'],
      ['a malformed ASVS id', { asvsRefs: ['v4-8.2.2'] }, 'asvsRefs'],
      ['a malformed CWE id', { cweCandidates: ['CWE-0'] }, 'cweCandidates'],
      ['an empty CWE list', { cweCandidates: [] }, 'cweCandidates'],
      [
        'a persona that is not a specialist (sub-planning cannot route)',
        { specialistPersona: 'planner' },
        'specialistPersona',
      ],
      [
        'a persona that does not exist',
        { specialistPersona: 'ghost-specialist' },
        'specialistPersona',
      ],
      ['an unknown run mode', { applicableModes: ['source'] }, 'applicableModes'],
      ['an empty mode list', { applicableModes: [] }, 'applicableModes'],
      ['a repeated mode', { applicableModes: ['black', 'black'] }, 'applicableModes'],
      ['a repeated OWASP id', { owaspRefs: ['A01', 'A01'] }, 'owaspRefs'],
      ['an unknown budget profile', { defaultBudgetProfile: 'huge' }, 'defaultBudgetProfile'],
    ];
    it.each(cases)('rejects %s', (_label, changes, path) => {
      const issues = issuesWith(changes);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((line) => line.includes(`.${path}`) || line.includes(`${path}:`))).toBe(
        true,
      );
    });
  });

  it('rejects an unknown field (a payload slot) instead of ignoring it', () => {
    const issues = issuesWith({ payload: "' OR 1=1" });
    expect(issues.join('\n')).toContain('Unrecognized key');
  });

  describe('negative control rules (F16, PLANNER-001)', () => {
    it('requires a negative control on every non-passive template', () => {
      const issues = issuesWith({ defaultNegativeControl: null });
      expect(issues.join('\n')).toContain('NEGATIVE_CONTROL_MISSING');
    });

    it('allows a passive template without a control', () => {
      expect(issuesWith({ class: 'passive', defaultNegativeControl: null })).toEqual([]);
    });

    it('rejects a control that does not suit the default oracle', () => {
      // access_matrix pairs only with alternate_role.
      const issues = issuesWith({ defaultNegativeControl: 'benign_variant' });
      expect(issues.join('\n')).toContain('NEGATIVE_CONTROL_ORACLE_MISMATCH');
    });

    it('accepts a control that suits the oracle', () => {
      expect(issuesWith({ defaultNegativeControl: 'alternate_role' })).toEqual([]);
    });
  });

  describe('library-level rules', () => {
    it('fails a duplicate templateId, so CI stops on two templates with one id', () => {
      const issues = issuesOf([base, { ...base, specialistPersona: 'web-api-specialist' }]);
      expect(issues).toEqual([expect.stringContaining('duplicate templateId')]);
    });

    it('fails an empty library', () => {
      expect(issuesOf([])).toEqual([expect.stringContaining('at least one template')]);
    });

    it('throws a TestCaseLibraryError with the registered code and one line per problem', () => {
      let caught: unknown;
      try {
        validateTemplateLibrary([
          { ...base, class: 'destructive' },
          { ...base, owaspRefs: ['A11'] },
        ]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TestCaseLibraryError);
      const err = caught as TestCaseLibraryError;
      expect(err.code).toBe('TEST_CASE_LIBRARY_INVALID');
      expect(err.issues.length).toBeGreaterThanOrEqual(2);
      expect(err.issues.every((line) => line.startsWith('['))).toBe(true);
    });

    it('never echoes an input value in the error (templates are data under review)', () => {
      const secret = 'PAYLOAD-SHAPED-VALUE-42';
      const issues = issuesWith({ templateId: secret, owaspRefs: [secret] });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.join('\n')).not.toContain(secret);
    });
  });

  describe('mode applicability and counts', () => {
    const parsed = validateTemplateLibrary([
      base,
      {
        ...base,
        templateId: 'code-only-check',
        applicableModes: ['white'],
        specialistPersona: 'code-specialist',
      },
    ]);

    it('excludes a source-only (white) template from black-box planning', () => {
      const black = templatesForMode(parsed, 'black');
      expect(black.map((t) => t.templateId)).toEqual(['athz-04-object-reference-access']);
    });

    it('keeps every template for white-box planning', () => {
      expect(templatesForMode(parsed, 'white')).toHaveLength(2);
    });

    it('counts templates per selectable class, with zero for empty classes', () => {
      expect(templateCountsByClass(parsed)).toEqual({
        passive: 0,
        active_safe: 2,
        state_changing: 0,
      });
    });
  });
});
