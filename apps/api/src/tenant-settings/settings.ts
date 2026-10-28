import {
  TENANT_SETTINGS_PII_KEYS,
  type TenantSettings,
  type TenantSettingsPatch,
  tenantSettingsPatchSchema,
  tenantSettingsSchema,
} from '@blackwing/contracts';
import { REDACTED, ValidationError } from '@blackwing/errors';

import { invalidTimezoneError, isInvalidTimezoneIssue } from './errors.js';
import { computeEtag } from '../concurrency/index.js';

/** One changed key: the value before and after. Values of personal-data keys are redacted before audit. */
export interface TenantSettingsChange {
  readonly from: unknown;
  readonly to: unknown;
}

/**
 * The ETag of a settings state (TENANT-008 requirement 2): a strong hash over the settings and the
 * instant they last changed. It changes on every write and is stable for an unchanged tenant.
 */
export function tenantSettingsEtag(settings: TenantSettings, updatedAt: Date): string {
  return computeEtag({ settings, updatedAt: updatedAt.toISOString() });
}

/**
 * Reads the stored JSONB through the strict schema, applying the defaults. A stored value that no longer
 * matches the schema throws: the API answers 500 rather than serving or writing guessed settings.
 */
export function parseStoredSettings(stored: Record<string, unknown>): TenantSettings {
  return tenantSettingsSchema.parse(stored);
}

/**
 * Validates a `PATCH` body. An unknown IANA zone is `invalid_timezone` (requirement 4); any other
 * violation (unknown key, region, bad value) is `validation_failed` with field paths only.
 */
export function parseTenantSettingsPatch(body: unknown): TenantSettingsPatch {
  const result = tenantSettingsPatchSchema.safeParse(body);
  if (result.success) return result.data;
  if (result.error.issues.some((issue) => isInvalidTimezoneIssue(issue)))
    throw invalidTimezoneError();
  // Field paths only: issue messages can echo submitted values.
  const fields = result.error.issues.map((issue) => issue.path.join('.') || '(body)');
  throw new ValidationError('invalid tenant settings', {
    detail: `Invalid fields: ${[...new Set(fields)].join(', ')}.`,
  });
}

/**
 * Applies a patch to the current settings. A `null` removes an optional key; an absent key is left as it
 * is. The result is parsed again, so defaults and the strict shape hold for what gets stored.
 */
export function applyTenantSettingsPatch(
  current: TenantSettings,
  patch: TenantSettingsPatch,
): TenantSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) Reflect.deleteProperty(next, key);
    else next[key] = value;
  }
  return tenantSettingsSchema.parse(next);
}

/** The keys whose value differs, with both values. Keys are sorted so the audit diff is deterministic. */
export function diffTenantSettings(
  before: TenantSettings,
  after: TenantSettings,
): Record<string, TenantSettingsChange> {
  const left: Record<string, unknown> = { ...before };
  const right: Record<string, unknown> = { ...after };
  const changes: Record<string, TenantSettingsChange> = {};
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (JSON.stringify(left[key]) === JSON.stringify(right[key])) continue;
    changes[key] = { from: left[key] ?? null, to: right[key] ?? null };
  }
  return changes;
}

const redactValue = (value: unknown): unknown => (value === null ? null : REDACTED);

/**
 * The audit form of a diff (requirement 6): keys are kept, values of personal-data keys are replaced by
 * the redaction marker. An unset value stays `null`, which reveals nothing.
 */
export function redactTenantSettingsChanges(
  changes: Readonly<Record<string, TenantSettingsChange>>,
): Record<string, TenantSettingsChange> {
  return Object.fromEntries(
    Object.entries(changes).map(([key, change]) =>
      TENANT_SETTINGS_PII_KEYS.includes(key)
        ? [key, { from: redactValue(change.from), to: redactValue(change.to) }]
        : [key, change],
    ),
  );
}
