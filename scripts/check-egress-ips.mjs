#!/usr/bin/env node
// Egress-IP list validation and drift check (INFRA-015, #50).
//
//   node scripts/check-egress-ips.mjs validate <document.json>
//   node scripts/check-egress-ips.mjs drift <document.json|https-url> <tofu-output.json>
//
// <tofu-output.json> is the result of `tofu output -json egress_ips` (a JSON array of addresses).
// `validate` checks the published document against the v1 schema and refuses private ranges.
// `drift` additionally fails when the published set differs from the OpenTofu output, which is the
// CI/alert condition "published != actual EIPs". Plain http:// sources are refused.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CIDR32 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/;
const KEYS = ['version', 'lastUpdated', 'egressIps', 'notes'];

/**
 * @param {number[]} o octets
 * @returns {boolean} true when the address is not publicly routable
 */
export function isNonPublic(o) {
  const [a = 0, b = 0] = o;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Validates a published document and returns the problems found (empty means valid).
 * @param {unknown} doc
 * @returns {string[]}
 */
export function validateDocument(doc) {
  /** @type {string[]} */
  const errors = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return ['document must be a JSON object'];
  }
  const rec = /** @type {Record<string, unknown>} */ (doc);
  for (const key of Object.keys(rec)) {
    if (!KEYS.includes(key)) errors.push(`unexpected field "${key}"`);
  }
  if (rec['version'] !== SCHEMA_VERSION) errors.push(`version must be ${SCHEMA_VERSION}`);
  const stamp = rec['lastUpdated'];
  if (typeof stamp !== 'string' || !ISO_UTC.test(stamp) || Number.isNaN(Date.parse(stamp))) {
    errors.push('lastUpdated must be an ISO-8601 UTC timestamp');
  }
  if (typeof rec['notes'] !== 'string') errors.push('notes must be a string');
  const ips = rec['egressIps'];
  if (!Array.isArray(ips) || ips.length === 0) {
    errors.push('egressIps must be a non-empty array');
    return errors;
  }
  const seen = new Set();
  for (const entry of ips) {
    const m = typeof entry === 'string' ? CIDR32.exec(entry) : null;
    if (!m) {
      errors.push(`egressIps entry ${JSON.stringify(entry)} must be an IPv4 /32 CIDR`);
      continue;
    }
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((n) => n > 255)) {
      errors.push(`egressIps entry ${String(entry)} has an octet above 255`);
      continue;
    }
    if (isNonPublic(octets)) {
      errors.push(
        `egressIps entry ${String(entry)} is not a public address (private/internal ranges must never be published)`,
      );
    }
    if (seen.has(entry)) errors.push(`egressIps entry ${String(entry)} is duplicated`);
    seen.add(entry);
  }
  return errors;
}

/**
 * Compares the published document with the `tofu output -json egress_ips` array.
 * @param {unknown} doc
 * @param {unknown} tofuOutput
 * @returns {string[]}
 */
export function driftErrors(doc, tofuOutput) {
  const errors = validateDocument(doc);
  if (!Array.isArray(tofuOutput) || !tofuOutput.every((x) => typeof x === 'string')) {
    return [...errors, 'tofu output must be a JSON array of address strings'];
  }
  const published = new Set(
    Array.isArray(/** @type {{egressIps?: unknown}} */ (doc).egressIps)
      ? /** @type {string[]} */ (/** @type {{egressIps: string[]}} */ (doc).egressIps)
      : [],
  );
  const actual = new Set(tofuOutput.map((ip) => `${ip}/32`));
  for (const ip of actual) {
    if (!published.has(ip)) errors.push(`drift: ${ip} is an egress EIP but is not published`);
  }
  for (const ip of published) {
    if (!actual.has(ip)) errors.push(`drift: ${ip} is published but is not an egress EIP`);
  }
  return errors;
}

/**
 * @param {string} source file path or https URL
 * @returns {Promise<unknown>}
 */
export async function load(source) {
  if (/^http:\/\//i.test(source)) throw new Error('refusing plain http: the list is TLS-only');
  if (/^https:\/\//i.test(source)) {
    const res = await fetch(source, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${source} returned ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('application/json')) throw new Error(`unexpected content-type "${type}"`);
    return res.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const [cmd, source, tofuFile] = argv;
  try {
    if (cmd === 'validate' && source) {
      const errors = validateDocument(await load(source));
      for (const e of errors) console.error(`egress-ips: ${e}`);
      return errors.length === 0 ? 0 : 1;
    }
    if (cmd === 'drift' && source && tofuFile) {
      const errors = driftErrors(await load(source), JSON.parse(readFileSync(tofuFile, 'utf8')));
      for (const e of errors) console.error(`egress-ips: ${e}`);
      return errors.length === 0 ? 0 : 1;
    }
  } catch (err) {
    console.error(`egress-ips: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.error(
    'usage: check-egress-ips.mjs validate <doc> | drift <doc|https-url> <tofu-output.json>',
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
