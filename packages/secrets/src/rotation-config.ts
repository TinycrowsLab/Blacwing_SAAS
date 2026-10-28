import { AppError } from '@blackwing/errors';

/** Environment of secret rotation (SECRETS-012). A bad value is a configuration defect: fail closed. */
export interface RotationConfig {
  /** `SECRET_ROTATION_ENABLED`: gates the scheduled rotation jobs. Off by default. */
  readonly enabled: boolean;
  /** `SECRET_VERSION_GRACE_MS`: how long a superseded version keeps resolving. */
  readonly graceMs: number;
  /** `KEK_ROTATION_CRON`: five-field schedule of the per-tenant KEK rotation. */
  readonly kekRotationCron: string;
}

/** One hour, the value the issue sets. */
export const DEFAULT_SECRET_VERSION_GRACE_MS = 3_600_000;
/** Quarterly: 03:00 UTC on the first day of January, April, July and October. */
export const DEFAULT_KEK_ROTATION_CRON = '0 3 1 1,4,7,10 *';
/** Shortest grace: a superseded version must outlive the clock skew between the app and the database. */
export const MIN_SECRET_VERSION_GRACE_MS = 60_000;
/** Longest grace a deployment may configure (30 days). */
export const MAX_SECRET_VERSION_GRACE_MS = 2_592_000_000;

const CRON_FIELDS = 5;
const CRON_FIELD = /^[0-9*/,-]+$/;

function integer(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d{1,10}$/.test(raw.trim())) {
    throw new AppError('CONFIG_INVALID', `${name} must be a non-negative integer`);
  }
  return Number(raw.trim());
}

function flag(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new AppError('CONFIG_INVALID', `${name} must be true or false`);
}

/** Parses the rotation environment; names only the key in an error, never a value. */
export function rotationConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): RotationConfig {
  const graceMs = integer(env, 'SECRET_VERSION_GRACE_MS', DEFAULT_SECRET_VERSION_GRACE_MS);
  if (graceMs < MIN_SECRET_VERSION_GRACE_MS || graceMs > MAX_SECRET_VERSION_GRACE_MS) {
    throw new AppError(
      'CONFIG_INVALID',
      'SECRET_VERSION_GRACE_MS must be between 60000 and 2592000000',
    );
  }
  const configured = env.KEK_ROTATION_CRON?.trim();
  const cron =
    configured === undefined || configured === '' ? DEFAULT_KEK_ROTATION_CRON : configured;
  const fields = cron.split(/\s+/);
  if (fields.length !== CRON_FIELDS || !fields.every((field) => CRON_FIELD.test(field))) {
    throw new AppError('CONFIG_INVALID', 'KEK_ROTATION_CRON must be a five-field cron expression');
  }
  return { enabled: flag(env, 'SECRET_ROTATION_ENABLED'), graceMs, kekRotationCron: cron };
}
