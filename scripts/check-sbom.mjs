#!/usr/bin/env node
// Validates a Syft CycloneDX SBOM for one built image (CI-008, #142) and prints a component-count
// summary. Fails (exit 1) when the SBOM is empty, malformed, not CycloneDX 1.5, or lacks the
// expected package ecosystems: OS packages (deb/apk/rpm) plus npm for the Node services or golang
// for the Go egress-gateway (distroless bases still list their dpkg packages and the app deps).
//
// Usage: node scripts/check-sbom.mjs --service <name> --sbom <file> [--image <ref>] [--summary <file>]

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Services whose application dependencies are Go modules; every other service is Node. */
export const GO_SERVICES = ['egress-gateway'];
const OS_TYPES = ['deb', 'apk', 'rpm'];

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {string} purl package URL
 * @returns {string} ecosystem type ("npm", "golang", "deb", ...) or ""
 */
export function purlType(purl) {
  const m = /^pkg:([a-z0-9.+-]+)\//i.exec(purl);
  return m?.[1]?.toLowerCase() ?? '';
}

/**
 * @param {string} text SBOM file contents
 * @param {string} service matrix service name
 * @returns {{ errors: string[], counts: Record<string, number>, total: number }}
 */
export function validateSbom(text, service) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { errors: ['SBOM is not valid JSON'], counts, total: 0 };
  }
  if (!isRecord(doc)) return { errors: ['SBOM is not a JSON object'], counts, total: 0 };
  if (doc.bomFormat !== 'CycloneDX') errors.push('bomFormat must be CycloneDX');
  if (doc.specVersion !== '1.5') {
    errors.push(`specVersion must be 1.5, got ${String(doc.specVersion)}`);
  }
  const components = Array.isArray(doc.components) ? doc.components : [];
  if (components.length === 0) errors.push('SBOM has no components');
  for (const c of components) {
    const purl = isRecord(c) && typeof c.purl === 'string' ? c.purl : '';
    const type = purlType(purl) || 'other';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  const lang = GO_SERVICES.includes(service) ? 'golang' : 'npm';
  if ((counts[lang] ?? 0) === 0) errors.push(`SBOM lists no ${lang} components for ${service}`);
  if (!OS_TYPES.some((t) => (counts[t] ?? 0) > 0)) errors.push('SBOM lists no OS packages');
  return { errors, counts, total: components.length };
}

/**
 * @param {string} service
 * @param {string} image
 * @param {Record<string, number>} counts
 * @param {number} total
 * @returns {string} Markdown table row for the job summary
 */
export function summaryLine(service, image, counts, total) {
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}: ${n}`)
    .join(', ');
  return `| ${service} | \`${image}\` | ${total} | ${parts} |\n`;
}

/** @param {string[]} argv */
export function main(argv) {
  const arg = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const service = arg('--service');
  const file = arg('--sbom');
  if (service === undefined || file === undefined) {
    process.stderr.write(
      'usage: check-sbom --service <name> --sbom <file> [--image <ref>] [--summary <file>]\n',
    );
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write(`check-sbom: cannot read ${file}\n`);
    return 1;
  }
  const { errors, counts, total } = validateSbom(text, service);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`check-sbom: ${service}: ${e}\n`);
    return 1;
  }
  const line = summaryLine(service, arg('--image') ?? '', counts, total);
  process.stdout.write(line);
  const summary = arg('--summary');
  if (summary !== undefined) appendFileSync(summary, line);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
