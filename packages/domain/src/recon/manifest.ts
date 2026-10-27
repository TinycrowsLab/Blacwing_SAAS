import {
  INTRUSIVENESS_ORDER,
  type IntrusivenessClass,
  type RunBudget,
  runBudgetSchema,
  type RunMode,
} from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

/**
 * Recon manifest (ORCH-004, CONTEXT_PACK §3.2 step 2): which recon personas run for each assessment mode.
 *
 * The one place the mode -> persona table lives. The run workflow dispatches from it and the planner
 * reads the same table to know which inputs the surface model was built from. Pure and deterministic.
 */

/** Personas that may run in the `recon` phase (§4.6). */
export const RECON_PERSONAS = [
  'passive-recon',
  'osint',
  'active-recon',
  'threat-intel',
  'source-spec-ingestion',
  'session-setup',
] as const;
export type ReconPersona = (typeof RECON_PERSONAS)[number];

/** Recon runs inside the SA envelope and may never be `state_changing` (§3.1, §3.4, §8.3). */
export type ReconIntrusiveness = Extract<IntrusivenessClass, 'passive' | 'active_safe'>;
export const RECON_INTRUSIVENESS_CEILING: ReconIntrusiveness = 'active_safe';

/**
 * Share of each run budget dimension recon may spend. Assumption (reversible): one fifth of the run
 * budget, so planning, execution and validation keep the rest.
 */
export const RECON_BUDGET_SHARE = 0.2;

/** Smallest slice a persona is given, so a tiny run budget never yields a zero (invalid) budget. */
const MIN_COST_USD = 0.0001;
const COST_PRECISION = 10_000;
/** The white-box confirm-only active-recon gets half the share of a full persona. */
const MINIMAL_WEIGHT = 0.5;

interface ManifestRow {
  readonly persona: ReconPersona;
  /** What the session is dispatched with; at most {@link RECON_INTRUSIVENESS_CEILING}. */
  readonly intrusiveness: ReconIntrusiveness;
  /** Relative share of the recon cost and request budget. */
  readonly weight: number;
  /** White box confirms the deployed surface only. */
  readonly minimal?: true;
}

const row = (
  persona: ReconPersona,
  intrusiveness: ReconIntrusiveness,
  weight = 1,
  minimal?: true,
): ManifestRow =>
  minimal ? { persona, intrusiveness, weight, minimal } : { persona, intrusiveness, weight };

const MANIFEST: Readonly<Record<RunMode, readonly ManifestRow[]>> = Object.freeze({
  black: Object.freeze([
    row('passive-recon', 'passive'),
    row('osint', 'passive'),
    row('active-recon', 'active_safe'),
    row('threat-intel', 'passive'),
  ]),
  grey: Object.freeze([
    row('active-recon', 'active_safe'),
    row('threat-intel', 'passive'),
    row('source-spec-ingestion', 'passive'),
    row('session-setup', 'active_safe'),
  ]),
  white: Object.freeze([
    row('source-spec-ingestion', 'passive'),
    row('threat-intel', 'passive'),
    row('session-setup', 'active_safe'),
    row('active-recon', 'active_safe', MINIMAL_WEIGHT, true),
  ]),
});

/** One recon session to dispatch. */
export interface ReconManifestEntry {
  readonly persona: ReconPersona;
  readonly intrusiveness: ReconIntrusiveness;
  /** True for the white-box "confirm the deployed surface only" active-recon. */
  readonly minimal: boolean;
  /** This persona's slice of the run budget. */
  readonly budget: RunBudget;
}

export type ReconManifestWarning = 'RECON_MANIFEST_MISSING_FELL_BACK_TO_ACTIVE_RECON';

export interface ReconManifest {
  readonly entries: readonly ReconManifestEntry[];
  /** The whole recon allowance (sum of the cost and request slices; the wall-clock cap applies to each child). */
  readonly reconBudget: RunBudget;
  readonly warnings: readonly ReconManifestWarning[];
}

export interface ResolveReconManifestOptions {
  /** Grey/white: an input manifest (spec, source, HAR) was supplied. Defaults to true. */
  readonly manifestSupplied?: boolean;
}

/** Never above the recon ceiling, whatever the table says. */
function capped(requested: IntrusivenessClass): ReconIntrusiveness {
  const ceiling = INTRUSIVENESS_ORDER[RECON_INTRUSIVENESS_CEILING];
  return INTRUSIVENESS_ORDER[requested] > ceiling
    ? RECON_INTRUSIVENESS_CEILING
    : (requested as ReconIntrusiveness);
}

/**
 * Resolves the recon personas for `mode` (CONTEXT_PACK §3.2) with a budget slice each, cut from the
 * run's `budgets`. Cost and request slices split by weight; the wall-clock slice is the whole recon
 * allowance because the sessions run in parallel. Grey/white with no supplied manifest falls back to a
 * full active-recon to confirm the surface and reports a warning. Throws `VALIDATION_FAILED` for an
 * unknown mode or an invalid budget (fail closed).
 */
export function resolveReconManifest(
  mode: RunMode,
  budgets: RunBudget,
  options: ResolveReconManifestOptions = {},
): ReconManifest {
  if (!Object.hasOwn(MANIFEST, mode)) {
    throw new ValidationError('Unknown assessment mode for the recon manifest', {
      detail: 'Unknown assessment mode.',
    });
  }
  const parsed = runBudgetSchema.safeParse(budgets);
  if (!parsed.success) {
    throw new ValidationError('Invalid run budgets for the recon manifest', {
      detail: 'Invalid run budgets.',
    });
  }
  const run = parsed.data;
  const fallback = mode !== 'black' && options.manifestSupplied === false;
  const rows = MANIFEST[mode].map((r) =>
    fallback && r.persona === 'active-recon' ? row('active-recon', 'active_safe') : r,
  );

  const reconCost = run.costCapUsd * RECON_BUDGET_SHARE;
  const reconRequests = run.maxRequests * RECON_BUDGET_SHARE;
  const durationMs = Math.max(1, Math.floor(run.maxDurationMs * RECON_BUDGET_SHARE));
  const totalWeight = rows.reduce((sum, r) => sum + r.weight, 0);

  const entries = rows.map((r): ReconManifestEntry => {
    const fraction = r.weight / totalWeight;
    return {
      persona: r.persona,
      intrusiveness: capped(r.intrusiveness),
      minimal: r.minimal === true,
      budget: {
        costCapUsd: Math.max(
          MIN_COST_USD,
          Math.floor(reconCost * fraction * COST_PRECISION) / COST_PRECISION,
        ),
        maxRequests: Math.max(1, Math.floor(reconRequests * fraction)),
        maxDurationMs: durationMs,
      },
    };
  });

  return {
    entries,
    reconBudget: {
      costCapUsd: Math.max(MIN_COST_USD, Math.floor(reconCost * COST_PRECISION) / COST_PRECISION),
      maxRequests: Math.max(1, Math.floor(reconRequests)),
      maxDurationMs: durationMs,
    },
    warnings: fallback ? ['RECON_MANIFEST_MISSING_FELL_BACK_TO_ACTIVE_RECON'] : [],
  };
}
