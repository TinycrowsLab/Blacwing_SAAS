import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PERSONA_NAMES } from '../persona.js';
import { parseDenylist } from '../prompt-lint.js';
import { libraryVersion } from './1.0.0/index.js';
import { loadTestCaseLibrary, TEST_CASE_LIBRARY_VERSION } from './library.js';
import {
  API_TOP10_IDS,
  SPECIALIST_PERSONAS,
  TestCaseLibraryError,
  templateCountsByClass,
  templatesForMode,
  WSTG_TOP_CATEGORIES,
} from './template.js';

const library = loadTestCaseLibrary();
const DENYLIST_PATH = new URL('../../lint/denylist.json', import.meta.url);

describe('test-case template library 1.0.0 (PLANNER-002)', () => {
  it('loads and validates every template against the schema', () => {
    expect(library.templates.length).toBeGreaterThan(0);
    expect(library.libraryVersion).toBe(libraryVersion);
    expect(TEST_CASE_LIBRARY_VERSION).toBe('1.0.0');
  });

  it('pins the planning version: an unknown version fails closed', () => {
    expect(() => loadTestCaseLibrary('9.9.9')).toThrow(TestCaseLibraryError);
  });

  it('is immutable: the list, every template and every ref array are frozen', () => {
    expect(Object.isFrozen(library)).toBe(true);
    expect(Object.isFrozen(library.templates)).toBe(true);
    const [first] = library.templates;
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.owaspRefs)).toBe(true);
    expect(Object.isFrozen(first?.applicableModes)).toBe(true);
  });

  it('covers every top-level WSTG category with at least one template', () => {
    for (const category of WSTG_TOP_CATEGORIES) {
      const prefix = `WSTG-${category}-`;
      const covered = library.templates.some((t) =>
        t.wstgRefs.some((ref) => ref.startsWith(prefix)),
      );
      expect(covered, `WSTG-${category} has no template`).toBe(true);
    }
  });

  it('covers each OWASP API Top 10 item with at least one template', () => {
    for (const id of API_TOP10_IDS) {
      const covered = library.templates.some((t) => t.owaspRefs.includes(id));
      expect(covered, `${id} has no template`).toBe(true);
    }
  });

  it('routes every template to one of the four specialist personas', () => {
    expect(SPECIALIST_PERSONAS.every((p) => PERSONA_NAMES.includes(p))).toBe(true);
    for (const t of library.templates) {
      expect(SPECIALIST_PERSONAS).toContain(t.specialistPersona);
    }
  });

  it('pins the template ids of this version (a change is a new version)', () => {
    expect(library.templates.map((t) => t.templateId)).toEqual([
      'info-02-web-fingerprint',
      'conf-05-admin-interfaces',
      'conf-07-security-headers',
      'clnt-07-cors-policy',
      'idnt-02-role-definitions',
      'idnt-04-account-enumeration',
      'athn-02-default-credentials',
      'athn-04-auth-bypass',
      'athn-07-weak-password-policy',
      'athz-01-path-traversal',
      'athz-02-function-level-access',
      'athz-04-object-reference-access',
      'sess-02-cookie-attributes',
      'sess-03-session-fixation',
      'inpv-01-reflected-xss',
      'inpv-05-sql-injection',
      'inpv-07-xml-external-entities',
      'inpv-12-command-injection',
      'inpv-18-server-side-template-injection',
      'inpv-19-server-side-request-forgery',
      'errh-01-error-disclosure',
      'cryp-01-weak-transport-policy',
      'cryp-04-weak-algorithm-source',
      'busl-01-data-validation',
      'busl-06-workflow-circumvention',
      'busl-07-usage-limits',
      'apit-01-graphql-introspection',
      'apit-03-object-property-authorization',
      'apit-09-api-inventory',
      'apit-10-unsafe-api-consumption',
      'code-inpv-05-source-to-sink-sql',
    ]);
  });

  it('holds only identifiers and enum values: no template matches the reviewed denylist', () => {
    const denylist = parseDenylist(readFileSync(DENYLIST_PATH, 'utf8'));
    const serialised = JSON.stringify(library.templates);
    for (const rule of denylist.rules) {
      const re = new RegExp(rule.pattern, rule.flags);
      expect(re.test(serialised), `denylist rule ${rule.id} matched`).toBe(false);
    }
  });

  it('keeps black-box planning free of source-only templates', () => {
    const black = templatesForMode(library.templates, 'black').map((t) => t.templateId);
    expect(black).not.toContain('code-inpv-05-source-to-sink-sql');
    expect(black).not.toContain('cryp-04-weak-algorithm-source');
    expect(black).toContain('athz-04-object-reference-access');
    expect(templatesForMode(library.templates, 'white')).toHaveLength(library.templates.length);
  });

  it('exposes the per-class counts for plan_templates_total{class}', () => {
    expect(templateCountsByClass(library.templates)).toEqual({
      passive: 5,
      active_safe: 25,
      state_changing: 1,
    });
  });
});
