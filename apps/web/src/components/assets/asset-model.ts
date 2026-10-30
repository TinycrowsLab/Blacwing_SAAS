// Asset console model (ASSET list and create dialog, #368). Pure: no React and no I/O, so the permission gate, the
// identifier rules and the create form's validation are unit-tested directly. The API normalises and checks every
// identifier again (ASSET-002, `apps/api/src/assets/identifiers.ts`) and stays the authority; these rules only stop
// an obviously wrong value before the request and say why.

import { z } from 'zod';

import {
  ASSET_ENVIRONMENTS,
  ASSET_IDENTIFIER_LIMIT,
  ASSET_TYPE_IDENTIFIER_KIND,
  ASSET_TYPES,
  type AssetType,
  type CreateAssetBody,
  createAssetBodySchema,
  LIMITS,
  ROLE_PERMISSIONS,
  isRole,
  type VerificationStatus,
} from '@blackwing/contracts';

/** Cosmetic gate of the console (enforcement is server-side, §8.11): the role must hold `asset:read`. */
export function canReadAssets(roles: readonly string[]): boolean {
  return roles.some((role) => isRole(role) && ROLE_PERMISSIONS[role].includes('asset:read'));
}

/** Cosmetic gate: creating an asset needs `asset:write`. Without it the create control is not offered. */
export function canWriteAssets(roles: readonly string[]): boolean {
  return roles.some((role) => isRole(role) && ROLE_PERMISSIONS[role].includes('asset:write'));
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_MAX = 253;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_FAMILY = 4;
const OCTET_MAX = 255;
const IPV6_FAMILY = 6;

/** 4 or 6 for an IP literal, 0 otherwise. The browser has no `net` module, so the check is done here. */
function ipFamily(value: string): number {
  const v4 = IPV4.exec(value);
  if (v4 !== null)
    return v4.slice(1).every((octet) => Number(octet) <= OCTET_MAX) ? IPV4_FAMILY : 0;
  if (!value.includes(':')) return 0;
  try {
    new URL(`http://[${value}]`);
    return IPV6_FAMILY;
  } catch {
    return 0;
  }
}

/**
 * Why one identifier line is not valid for an asset type, or null when it is. The kind comes from the type
 * (`ASSET_TYPE_IDENTIFIER_KIND`), so the form asks for values only. Mirrors the server's syntax rules; a value the
 * server still refuses comes back as a 422 that the dialog shows.
 */
export function identifierProblem(type: AssetType, raw: string): string | null {
  const value = raw.trim();
  if (value === '') return 'Enter an identifier';
  if (value.length > LIMITS.urlMax) return `Keep it under ${String(LIMITS.urlMax)} characters`;
  switch (ASSET_TYPE_IDENTIFIER_KIND[type]) {
    case 'host': {
      const host = value.toLowerCase().replace(/\.$/, '');
      if (ipFamily(host) !== 0) return null;
      if (host.length > HOSTNAME_MAX || !host.split('.').every((label) => HOST_LABEL.test(label))) {
        return 'Expected a DNS hostname or an IP address';
      }
      return null;
    }
    case 'url':
      return urlProblem(value, ['http:', 'https:']);
    case 'repo':
      return repoProblem(value);
    case 'cidr':
      return cidrProblem(value);
  }
}

function urlProblem(value: string, schemes: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Expected an absolute URL';
  }
  if (!schemes.includes(url.protocol)) return `Scheme must be ${schemes.join(' or ')}`;
  if (url.username !== '' || url.password !== '') return 'A URL must not embed credentials';
  if (url.hostname === '') return 'URL has no host';
  return null;
}

function repoProblem(value: string): string | null {
  const problem = urlProblem(value, ['https:']);
  if (problem !== null) return problem;
  const path = new URL(value).pathname.replace(/\/$/, '').replace(/\.git$/, '');
  return path === '' || path === '/' ? 'Repository URL must name a path' : null;
}

function cidrProblem(value: string): string | null {
  const parts = value.split('/');
  if (parts.length !== 2) return 'Expected CIDR notation, for example 10.0.0.0/24';
  const [address = '', prefixText = ''] = parts;
  const family = ipFamily(address);
  if (family === 0) return 'The address is not an IP address';
  const bits = family === IPV4_FAMILY ? IPV4_BITS : IPV6_BITS;
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > bits) {
    return `The prefix must be between 0 and ${String(bits)}`;
  }
  return null;
}

/** The create form's values. Identifiers are one per line; the owner is the signed-in user (set on submit). */
export const createAssetFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(LIMITS.labelMax),
    type: z.enum(ASSET_TYPES),
    environment: z.enum(ASSET_ENVIRONMENTS),
    identifiers: z.string(),
  })
  .superRefine((values, ctx) => {
    const lines = identifierLines(values.identifiers);
    if (lines.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifiers'],
        message: 'Enter at least one identifier, one per line',
      });
      return;
    }
    if (lines.length > ASSET_IDENTIFIER_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifiers'],
        message: `An asset holds at most ${String(ASSET_IDENTIFIER_LIMIT)} identifiers; split the list`,
      });
      return;
    }
    lines.forEach((line, index) => {
      const problem = identifierProblem(values.type, line);
      if (problem !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['identifiers'],
          message: `Line ${String(index + 1)}: ${problem}`,
        });
      }
    });
  });

export type CreateAssetFormValues = z.input<typeof createAssetFormSchema>;

/** The non-empty, trimmed lines of the identifier box. */
export function identifierLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The `POST /v1/assets` body for valid form values and the owner. Parsed with the shared contract, so a body the
 * API would refuse for shape never leaves the console.
 */
export function toCreateAssetBody(
  values: CreateAssetFormValues,
  ownerUserId: string,
): CreateAssetBody {
  return createAssetBodySchema.parse({
    type: values.type,
    name: values.name.trim(),
    environment: values.environment,
    ownerUserId,
    identifiers: identifierLines(values.identifiers).map((value) => ({
      kind: ASSET_TYPE_IDENTIFIER_KIND[values.type],
      value,
    })),
  });
}

/** The label of each verification state. The badge pairs it with an icon and a colour, never colour alone. */
export const VERIFICATION_LABELS: Readonly<Record<VerificationStatus, string>> = {
  unverified: 'Unverified',
  pending: 'Pending',
  verified: 'Verified',
  rejected: 'Rejected',
};

/** Why an asset cannot be assessed yet, shown next to its verification badge. */
export function verificationHint(status: VerificationStatus): string {
  switch (status) {
    case 'verified':
      return 'Ownership is proved. The asset can be assessed.';
    case 'pending':
      return 'Ownership proof is in progress. The asset cannot be assessed yet.';
    case 'rejected':
      return 'Ownership proof was rejected. Verify the asset again before assessing it.';
    case 'unverified':
      return 'Ownership is not proved. Verify the asset before assessing it.';
  }
}
