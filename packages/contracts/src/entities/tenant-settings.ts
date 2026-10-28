import { z } from 'zod';

import { runModeSchema } from './run.js';

/**
 * Tenant settings (TENANT-008 / settings API, CONTEXT_PACK §5, §7, §9). Stored as typed JSONB on
 * `tenants.settings`. Every instant stays UTC in storage; `displayTimezone` only drives presentation
 * (test windows, cost-cap month display), so it is validated against the runtime's IANA tz database.
 */

/** Presentation default: storage is UTC, the zone only changes how instants are shown. */
export const DEFAULT_DISPLAY_TIMEZONE = 'UTC';

/** Longest zone name the API accepts (IANA names are far shorter). */
const MAX_TIMEZONE_LENGTH = 64;

/**
 * IANA zone name shape: letter-led segments of letters, digits, `_`, `+`, `-`, separated by `/`. It excludes
 * UTC offsets (`+05:00`), whitespace, NUL and dot segments before `Intl` is even asked.
 */
const IANA_NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * True when `value` is an IANA zone name the runtime knows (`Europe/Berlin`, `UTC`, and aliases such as
 * `Asia/Kolkata`). `Intl` is the tz database here, so there is no hand-kept list to drift. A case variant
 * of a known name (`utc`, `europe/berlin`) is rejected, so storage holds exactly one spelling per zone.
 */
export function isIanaTimeZone(value: string): boolean {
  if (!IANA_NAME_SHAPE.test(value)) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  return value === resolved || value.toLowerCase() !== resolved.toLowerCase();
}

/** Zod schema of a zone name. The issue code is `custom` for an unknown zone (the API maps it to `invalid_timezone`). */
export const timeZoneSchema = z
  .string()
  .max(MAX_TIMEZONE_LENGTH)
  .refine(isIanaTimeZone, { message: 'must be an IANA time zone name, such as Europe/Berlin' });

/** `weekStartsOn`: 0 = Sunday, 1 = Monday. */
export const weekStartsOnSchema = z.union([z.literal(0), z.literal(1)]);

/**
 * The settings of a tenant, with defaults applied. `strict()` rejects unknown keys, so a settings
 * write cannot smuggle a new field (or region, which is read-only) into storage.
 */
export const tenantSettingsSchema = z.strictObject({
  displayTimezone: timeZoneSchema.default(DEFAULT_DISPLAY_TIMEZONE),
  defaultAssessmentMode: runModeSchema.default('grey'),
  /** PII: redacted in audit diffs and logs (see {@link TENANT_SETTINGS_PII_KEYS}). */
  defaultNotificationEmail: z.email().optional(),
  weekStartsOn: weekStartsOnSchema.optional(),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

/**
 * `PATCH` body: any subset of the settings. `null` clears an optional key (`defaultNotificationEmail`,
 * `weekStartsOn`); the non-optional keys cannot be cleared. An empty object is a valid no-op.
 */
export const tenantSettingsPatchSchema = z.strictObject({
  displayTimezone: timeZoneSchema.optional(),
  defaultAssessmentMode: runModeSchema.optional(),
  defaultNotificationEmail: z.email().nullable().optional(),
  weekStartsOn: weekStartsOnSchema.nullable().optional(),
});
export type TenantSettingsPatch = z.infer<typeof tenantSettingsPatchSchema>;

/** Settings keys whose values are personal data: audit and logs record the key, never the value. */
export const TENANT_SETTINGS_PII_KEYS: readonly string[] = Object.freeze([
  'defaultNotificationEmail',
]);

/** What `GET` and `PATCH` answer: the settings, the read-only data region and the last change. */
export const tenantSettingsResponseSchema = z.strictObject({
  settings: tenantSettingsSchema,
  /** Read-only: set at tenant creation (§7 `tenants.region`). Changing it is not a settings operation. */
  region: z.string(),
  updatedAt: z.iso.datetime(),
});
export type TenantSettingsResponse = z.infer<typeof tenantSettingsResponseSchema>;
