// Tenant policy sets (POLICY-001, CONTEXT_PACK §8.11). The platform baseline is always the first layer of
// the effective policy set and is never replaceable; a tenant's active version sits after it. A tenant with
// no active version evaluates the baseline alone, never an empty or fail-open set.

import { createHash } from 'node:crypto';

import { BASELINE_VERSION, baselineDigest, loadBaseline, type Baseline } from './baseline.js';

/**
 * The canonical form of a tenant policy source, the text that is stored and hashed: LF line endings,
 * no trailing whitespace on any line, no trailing blank lines, and exactly one final newline (or the
 * empty string for an empty set). Two sources that differ only in those details get the same digest.
 */
export function canonicalPolicySource(source: string): string {
  const lines = source
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** SHA-256 (hex) over the UTF-8 bytes of the canonical source. Stable for identical canonical source. */
export function policySourceSha256(source: string): string {
  return createHash('sha256').update(canonicalPolicySource(source), 'utf8').digest('hex');
}

/** One layer of the effective set: a version label, its digest and its canonical text. */
export interface PolicySetLayer {
  readonly version: string;
  readonly sha256: string;
  readonly source: string;
}

/** The input to the engine (POLICY-006) and to the snapshot (POLICY-007): baseline first, tenant second. */
export interface EffectivePolicySet {
  readonly baseline: PolicySetLayer;
  /** `null` when the tenant has no active version: the baseline alone applies. */
  readonly tenant: PolicySetLayer | null;
}

/** A stored tenant version as the assembly needs it. */
export interface TenantPolicyVersionRef {
  readonly version: number;
  readonly sha256: string;
  readonly cedarSource: string;
}

/**
 * Assembles the effective policy set for a tenant: the baseline first, then the tenant's active version
 * (if any). Pure: the baseline is read from the shipped files unless one is passed (tests).
 */
export function assembleEffectivePolicySet(
  tenant: TenantPolicyVersionRef | null,
  baseline: Baseline = loadBaseline(),
): EffectivePolicySet {
  return {
    baseline: {
      version: BASELINE_VERSION,
      sha256: baselineDigest(baseline),
      source: baseline.files.map((f) => f.source).join('\n'),
    },
    tenant:
      tenant === null
        ? null
        : {
            version: String(tenant.version),
            sha256: tenant.sha256,
            source: canonicalPolicySource(tenant.cedarSource),
          },
  };
}
