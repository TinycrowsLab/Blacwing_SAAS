import {
  type OrgProfile,
  orgProfileSchema,
  orgSettingsPatchSchema,
  type OrgSettingsPatch,
  type TenantSettings,
  type TenantSettingsPatch,
} from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { computeEtag } from '../concurrency/index.js';
import {
  applyTenantSettingsPatch,
  parseStoredSettings,
  redactTenantSettingsChanges,
} from '../tenant-settings/settings.js';

import type { TenantProfileChange, TenantProfileRecord } from './ports.js';

/** The editable organisation fields, as the audit diff and the response name them. */
export interface OrgFields {
  readonly name: string;
  readonly defaultTimezone: string;
  readonly supportContactEmail: string | null;
}

/**
 * The fields of a stored profile. `defaultTimezone` is the tenant's `displayTimezone` and
 * `supportContactEmail` the tenant's support setting (TENANT-008 settings document), so both settings
 * surfaces read and write the same values.
 */
export function orgFieldsOf(name: string, settings: TenantSettings): OrgFields {
  return {
    name,
    defaultTimezone: settings.displayTimezone,
    supportContactEmail: settings.supportContactEmail ?? null,
  };
}

/** The ETag of a profile state (ADMIN-001 requirement 2): a strong hash over the name, settings and last change. */
export function orgProfileEtag(name: string, settings: TenantSettings, updatedAt: Date): string {
  return computeEtag({ name, settings, updatedAt: updatedAt.toISOString() });
}

/** The response of `GET` and `PATCH /v1/tenants/current`: the whole profile, with defaults applied. */
export function orgProfileView(record: TenantProfileRecord): OrgProfile {
  const settings = parseStoredSettings(record.settings);
  const fields = orgFieldsOf(record.name, settings);
  return orgProfileSchema.parse({
    name: fields.name,
    slug: record.slug,
    region: record.region,
    plan: record.plan,
    status: record.status,
    defaultTimezone: fields.defaultTimezone,
    supportContactEmail: fields.supportContactEmail,
    updatedAt: record.updatedAt.toISOString(),
  });
}

/**
 * Validates a `PATCH` body. Any violation is `VALIDATION_FAILED` with field paths only: issue messages can
 * echo submitted values, and a name or an e-mail address must not reach the error body or the logs.
 */
export function parseOrgSettingsPatch(body: unknown): OrgSettingsPatch {
  const result = orgSettingsPatchSchema.safeParse(body);
  if (result.success) return result.data;
  const fields = result.error.issues.map((issue) => issue.path.join('.') || '(body)');
  throw new ValidationError('invalid organisation settings', {
    detail: `Invalid fields: ${[...new Set(fields)].join(', ')}.`,
  });
}

/** The tenant-settings patch that carries the profile's settings fields (the name is a column, not a setting). */
function settingsPatchOf(patch: OrgSettingsPatch): TenantSettingsPatch {
  const settings: TenantSettingsPatch = {};
  if (patch.defaultTimezone !== undefined) settings.displayTimezone = patch.defaultTimezone;
  if (patch.supportContactEmail !== undefined)
    settings.supportContactEmail = patch.supportContactEmail;
  return settings;
}

/**
 * The keys whose value differs between two profiles, with both values, sorted so the audit diff is
 * deterministic. Personal-data values (the support contact) are redacted before they leave this module.
 */
export function diffOrgFields(
  before: OrgFields,
  after: OrgFields,
): Record<string, TenantProfileChange> {
  const changes: Record<string, TenantProfileChange> = {};
  for (const key of Object.keys(before).sort() as (keyof OrgFields)[]) {
    if (before[key] === after[key]) continue;
    changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return redactTenantSettingsChanges(changes);
}

/** The profile after applying `patch` to `current`, with the settings re-parsed so the stored shape stays strict. */
export function applyOrgSettingsPatch(
  current: TenantSettings,
  name: string,
  patch: OrgSettingsPatch,
): { readonly name: string; readonly settings: TenantSettings } {
  return {
    name: patch.name ?? name,
    settings: applyTenantSettingsPatch(current, settingsPatchOf(patch)),
  };
}
