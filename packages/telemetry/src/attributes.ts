import { isSensitiveKey, redactText } from '@blackwing/logger';

import type { AttributeValue, Attributes } from '@opentelemetry/api';

/**
 * Attribute keys that never leave the process as span or log attributes, whatever their value (§8.7). The
 * list is matched per dot-separated key segment, with case, `-`, `_` and spaces ignored, so `user.email`
 * and `Email` are both refused.
 */
const PII_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  'address',
  'birthdate',
  'dob',
  'email',
  'firstname',
  'fullname',
  'ipaddress',
  'lastname',
  'mobile',
  'passport',
  'phone',
  'ssn',
]);

function normaliseSegment(segment: string): string {
  return segment.toLowerCase().replace(/[-_\s]/g, '');
}

/** True when `key` names a secret, a credential or personal data that must not become an attribute. */
function isForbiddenAttributeKey(key: string): boolean {
  if (isSensitiveKey(key)) return true;
  return key
    .split('.')
    .some((segment) => PII_KEY_SEGMENTS.has(normaliseSegment(segment)) || isSensitiveKey(segment));
}

/** True when a string carries a Blackwing credential or any built-in credential shape (`bwk_`, `bw_pat_`…). */
function carriesSecret(value: string): boolean {
  return redactText(value) !== value;
}

function isSecretValue(value: AttributeValue | undefined): boolean {
  if (typeof value === 'string') return carriesSecret(value);
  if (Array.isArray(value))
    return value.some((item) => typeof item === 'string' && carriesSecret(item));
  return false;
}

/**
 * Returns `{ [key]: value }` when the attribute is safe to export, and `{}` otherwise, so callers spread
 * the result into span or log attributes: `span.setAttributes({ ...safeAttr('plan.id', id) })`. An attribute
 * is dropped when its key is on the PII or secret denylist, or when its value matches a secret-ref pattern
 * (`bwk_`, `bw_pat_`, `bw_ci_`, run tokens) or a built-in credential shape. Dropping is silent by design:
 * the telemetry path never throws into the request path (§8.7, OBS-001).
 */
export function safeAttr(key: string, value: AttributeValue | undefined): Attributes {
  if (isForbiddenAttributeKey(key) || isSecretValue(value)) return {};
  return { [key]: value };
}
