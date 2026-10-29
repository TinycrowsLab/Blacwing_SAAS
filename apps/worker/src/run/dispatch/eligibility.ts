import { intrusivenessRank, type DispatchRejectionCode } from '@blackwing/contracts';

import type { DispatchTestCase, PersonaProfile } from './ports.js';

/** A refusal with a stable code; the dispatcher turns it into a rejected outcome. */
export class DispatchRejection extends Error {
  constructor(
    readonly code: DispatchRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'DispatchRejection';
  }
}

const WSTG_RE = /\bWSTG-([A-Z]{4})(?:-(\d{2}(?:\/\d{2})*))?(?![\w-])/g;
const WSTG_CATEGORY_RE = /^(WSTG-[A-Z]{4})/;
const CWE_RE = /\bCWE-[1-9]\d{0,4}\b/g;
const OWASP_RE = /\bA(?:0[1-9]|10)\b/g;
const API_RE = /\bAPI(?:[1-9]|10)\b/g;

/**
 * The standard ids a text names. `WSTG-INPV-05/01` names two exact ids; a bare `WSTG-CONF` names the
 * category `WSTG-CONF`, which covers every id in it.
 */
export function standardIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(WSTG_RE)) {
    const [, category, numbers] = match;
    if (category === undefined) continue;
    if (numbers === undefined) ids.add(`WSTG-${category}`);
    else for (const n of numbers.split('/')) ids.add(`WSTG-${category}-${n}`);
  }
  for (const re of [CWE_RE, OWASP_RE, API_RE]) {
    for (const match of text.matchAll(re)) ids.add(match[0]);
  }
  return ids;
}

/** True when the persona's mandate names any standard id of the test case (or its WSTG category). */
export function mandateCovers(mandate: string, testCase: DispatchTestCase): boolean {
  const covered = standardIds(mandate);
  const wanted = standardIds([...testCase.owasp, ...testCase.wstg, ...testCase.cwe].join(' '));
  for (const id of wanted) {
    if (covered.has(id)) return true;
    const category = WSTG_CATEGORY_RE.exec(id)?.[1];
    if (category !== undefined && covered.has(category)) return true;
  }
  return false;
}

/**
 * Deterministic persona eligibility (§8.11: code, never model trust). The mandate metadata comes from the
 * persona registry, not from a table in this file. Rejects when the mandate does not cover the test
 * case's standards, when the brief asks for more intrusiveness than the persona's ceiling or than the
 * approved test case, and when a state-changing case is not approved.
 */
export function assertPersonaEligible(
  persona: PersonaProfile,
  testCase: DispatchTestCase,
  requested: DispatchTestCase['class'],
): void {
  if (requested !== testCase.class) {
    throw new DispatchRejection(
      'INVALID_REQUEST',
      `brief class ${requested} differs from the test case class ${testCase.class}`,
    );
  }
  if (!mandateCovers(persona.mandate, testCase)) {
    throw new DispatchRejection(
      'PERSONA_INELIGIBLE',
      `persona ${persona.name} does not cover this test case`,
    );
  }
  if (intrusivenessRank(requested) > intrusivenessRank(persona.intrusivenessCeiling)) {
    throw new DispatchRejection(
      'PERSONA_INELIGIBLE',
      `persona ${persona.name} may not run ${requested} (ceiling ${persona.intrusivenessCeiling})`,
    );
  }
  const approved = testCase.status === 'approved' || testCase.status === 'executing';
  if (!approved) {
    throw new DispatchRejection('TEST_CASE_NOT_APPROVED', `test case is ${testCase.status}`);
  }
}
