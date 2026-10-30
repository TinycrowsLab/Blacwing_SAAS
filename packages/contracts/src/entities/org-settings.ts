import { z } from 'zod';

import { TENANT_STATUSES } from './tenancy.js';
import { timeZoneSchema } from './tenant-settings.js';

/**
 * Organisation profile (ADMIN-001, CONTEXT_PACK §7 `tenants`, §9). The organisation is the tenant. Its
 * editable fields are `name`, `defaultTimezone` and `supportContactEmail`; `slug`, `region`, `plan` and
 * `status` are read-only here. `defaultTimezone` is the tenant settings' `displayTimezone` (TENANT-008) and
 * `supportContactEmail` is a tenant setting too, so the two settings surfaces never disagree.
 */

/** Longest organisation name the API accepts (characters, as JavaScript counts string length). */
export const ORG_NAME_MAX_LENGTH = 120;

/** No control characters (C0, C1, NUL, line breaks): a name is printed in audit, toasts and tables. */
const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;

/** Organisation name: 1 to 120 characters after trimming, no control characters. Unicode (RTL, emoji) is allowed. */
export const orgNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'must not be empty' })
  .max(ORG_NAME_MAX_LENGTH, {
    message: `must be at most ${String(ORG_NAME_MAX_LENGTH)} characters`,
  })
  .regex(NO_CONTROL_CHARACTERS, { message: 'must not contain control characters' });

/**
 * Support contact: a valid e-mail address, or empty / `null` to clear it. The output is `null` for an
 * empty value, so the stored form never holds an empty string.
 */
export const supportContactEmailSchema = z
  .union([z.email(), z.literal(''), z.null()])
  .transform((value) => (value === '' ? null : value));

/**
 * The editable organisation fields, as the form submits them and as `PATCH /v1/tenants/current` accepts
 * them (the PATCH body is this schema with every key optional). Strict: slug, region and plan are refused.
 */
export const orgSettingsSchema = z.strictObject({
  name: orgNameSchema,
  defaultTimezone: timeZoneSchema,
  supportContactEmail: supportContactEmailSchema,
});
export type OrgSettings = z.output<typeof orgSettingsSchema>;

/** `PATCH /v1/tenants/current` body: any subset of the editable fields. An empty object is a no-op. */
export const orgSettingsPatchSchema = orgSettingsSchema.partial();
export type OrgSettingsPatch = z.output<typeof orgSettingsPatchSchema>;

/** What `GET` and `PATCH /v1/tenants/current` answer: the whole profile and the time of the last change. */
export const orgProfileSchema = z.strictObject({
  name: z.string(),
  slug: z.string(),
  region: z.string(),
  plan: z.string(),
  status: z.enum(TENANT_STATUSES),
  defaultTimezone: timeZoneSchema,
  supportContactEmail: z.email().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OrgProfile = z.output<typeof orgProfileSchema>;
