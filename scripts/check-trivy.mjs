#!/usr/bin/env node
// Trivy policy helpers (CI-009, #143).
//
//   ignore   validates the .trivyignore allowlist: every entry needs a `# reason:` and a
//            `# expires: YYYY-MM-DD` comment directly above it, the id line must repeat the date as
//            Trivy's native `exp:YYYY-MM-DD` (so Trivy itself stops ignoring it on expiry), the date
//            must be in the future and at most MAX_DAYS ahead, and ids must be unique.
//   summary  prints per-severity counts from a Trivy SARIF file (job summary).
//   wiring   checks the trivy.yml / build-images.yml wiring (gate, SARIF, digest scan, permissions).
//
// Usage:
//   node scripts/check-trivy.mjs ignore [--file .trivyignore] [--today YYYY-MM-DD]
//   node scripts/check-trivy.mjs summary --sarif <file> --label <name> [--summary <file>]
//   node scripts/check-trivy.mjs wiring [--root <dir>]

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `yaml` is loaded lazily, only by the wiring check: the fs scan job runs `summary` without a
// `pnpm install`, so a top-level import would fail there.
/** @type {(id: string) => unknown} */
const requireModule = createRequire(import.meta.url);

export const IGNORE_FILE = '.trivyignore';
export const WORKFLOW = '.github/workflows/trivy.yml';
export const IMAGES_WORKFLOW = '.github/workflows/build-images.yml';
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
/** Longest allowed allowlist lifetime; forces periodic re-review. */
export const MAX_DAYS = 180;
export const DAY_MS = 86_400_000;
const DATE_LENGTH = 10;
const MIN_REASON = 10;
const EXP_PREFIX = 'exp:';
/** @param {Date} d @returns {string} YYYY-MM-DD in UTC */
export const isoDate = (d) => d.toISOString().slice(0, DATE_LENGTH);
const ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$|^[A-Z]{2,5}\d{3,5}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {string} s YYYY-MM-DD
 * @returns {number | undefined} UTC midnight in ms, undefined when not a real calendar date
 */
export function parseDate(s) {
  const m = DATE.exec(s);
  if (m === null) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - Number(true), Number(m[3]));
  return isoDate(new Date(ms)) === s ? ms : undefined;
}

/**
 * @param {string} text .trivyignore contents
 * @param {string} today YYYY-MM-DD
 * @returns {{ entries: { id: string, expires: string, reason: string, line: number }[], errors: string[] }}
 */
export function validateIgnore(text, today) {
  /** @type {string[]} */
  const errors = [];
  /** @type {{ id: string, expires: string, reason: string, line: number }[]} */
  const entries = [];
  const now = parseDate(today);
  if (now === undefined) return { entries, errors: [`invalid --today '${today}'`] };
  const seen = new Set();
  let reason = '';
  let expires = '';
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    const where = `${IGNORE_FILE}:${String(index + 1)}`;
    if (line === '') {
      reason = '';
      expires = '';
      return;
    }
    if (line.startsWith('#')) {
      const body = line.replace(/^#\s*/, '');
      const r = /^reason:\s*(.*)$/i.exec(body);
      const e = /^expires:\s*(\S*)/i.exec(body);
      if (r !== null) reason = (r[1] ?? '').trim();
      else if (e !== null) expires = e[1] ?? '';
      return;
    }
    const [id = '', ...rest] = line.split(/\s+/);
    const exp = rest.find((t) => t.startsWith(EXP_PREFIX))?.slice(EXP_PREFIX.length) ?? '';
    const extra = rest.filter((t) => !t.startsWith(EXP_PREFIX));
    /** @type {string[]} */
    const problems = [];
    if (!ID.test(id)) problems.push('not a vulnerability or misconfiguration id');
    if (extra.length > 0)
      problems.push(`unexpected text '${extra.join(' ')}' (use comments above)`);
    if (reason.length < MIN_REASON)
      problems.push('missing justification (`# reason: ...`, min 10 chars)');
    const expMs = parseDate(expires);
    if (expires === '') problems.push('missing `# expires: YYYY-MM-DD`');
    else if (expMs === undefined) problems.push(`invalid expiry '${expires}'`);
    else if (expMs <= now) problems.push(`expired on ${expires}`);
    else if ((expMs - now) / DAY_MS > MAX_DAYS) {
      problems.push(`expiry ${expires} is more than ${String(MAX_DAYS)} days ahead`);
    }
    if (exp !== expires) problems.push(`id line must carry 'exp:${expires || 'YYYY-MM-DD'}'`);
    if (seen.has(id)) problems.push('duplicate entry');
    seen.add(id);
    for (const p of problems) errors.push(`${where}: ${id}: ${p}`);
    entries.push({ id, expires, reason, line: index + 1 });
    reason = '';
    expires = '';
  });
  return { entries, errors };
}

/**
 * Counts SARIF results per severity (from the rule tags Trivy writes).
 * @param {string} text SARIF JSON
 * @returns {{ counts: Record<string, number>, total: number, error?: string }}
 */
export function summarizeSarif(text) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { counts, total: 0, error: 'SARIF is not valid JSON' };
  }
  const runs = isRecord(doc) && Array.isArray(doc.runs) ? doc.runs : undefined;
  if (runs === undefined) return { counts, total: 0, error: 'SARIF has no runs' };
  let total = 0;
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const driver = isRecord(run.tool) && isRecord(run.tool.driver) ? run.tool.driver : {};
    /** @type {Map<string, string>} */
    const sev = new Map();
    for (const rule of Array.isArray(driver.rules) ? driver.rules : []) {
      if (!isRecord(rule) || typeof rule.id !== 'string') continue;
      const tags =
        isRecord(rule.properties) && Array.isArray(rule.properties.tags)
          ? rule.properties.tags
          : [];
      sev.set(rule.id, String(tags.find((t) => SEVERITIES.includes(String(t))) ?? 'UNKNOWN'));
    }
    for (const r of Array.isArray(run.results) ? run.results : []) {
      const id = isRecord(r) && typeof r.ruleId === 'string' ? r.ruleId : '';
      const s = sev.get(id) ?? 'UNKNOWN';
      counts[s] = (counts[s] ?? 0) + 1;
      total += 1;
    }
  }
  return { counts, total };
}

/**
 * @param {string} label
 * @param {Record<string, number>} counts
 * @param {number} total
 * @returns {string} one markdown table row
 */
export function summaryLine(label, counts, total) {
  const parts = SEVERITIES.map((s) => `${s} ${String(counts[s] ?? 0)}`).join(' | ');
  return `| ${label} | ${String(total)} | ${parts} |`;
}

/**
 * @param {string} file
 * @returns {Record<string, unknown> | undefined}
 */
function load(file) {
  if (!existsSync(file)) return undefined;
  const yaml = /** @type {{ parse: (text: string) => unknown }} */ (requireModule('yaml'));
  /** @type {unknown} */
  const doc = yaml.parse(readFileSync(file, 'utf8'));
  return isRecord(doc) ? doc : undefined;
}

/**
 * @param {string} root repo root
 * @returns {string[]} wiring problems
 */
export function checkWiring(root) {
  /** @type {string[]} */
  const errors = [];
  const wf = load(path.join(root, WORKFLOW));
  if (wf === undefined) return [`${WORKFLOW} is missing or invalid`];
  const text = readFileSync(path.join(root, WORKFLOW), 'utf8');
  const jobs = isRecord(wf.jobs) ? wf.jobs : {};
  for (const name of ['allowlist', 'fs']) {
    if (!isRecord(jobs[name])) errors.push(`${WORKFLOW}: job '${name}' is missing`);
  }
  if (!text.includes('upload-sarif')) errors.push(`${WORKFLOW}: SARIF is not uploaded`);
  if (!text.includes('check-trivy.mjs ignore'))
    errors.push(`${WORKFLOW}: allowlist is not checked`);
  if (!/exit-code:\s*'?1'?/.test(text)) errors.push(`${WORKFLOW}: no exit-code 1 severity gate`);
  if (!/severity:\s*'?HIGH,CRITICAL/.test(text))
    errors.push(`${WORKFLOW}: gate must cover HIGH,CRITICAL`);
  if (!text.includes('trivyignores'))
    errors.push(`${WORKFLOW}: .trivyignore is not passed to Trivy`);
  if (!/scanners:.*misconfig/.test(text))
    errors.push(`${WORKFLOW}: fs scan must include the misconfig scanner`);

  const img = load(path.join(root, IMAGES_WORKFLOW));
  const imgJobs = img !== undefined && isRecord(img.jobs) ? img.jobs : {};
  const trivy = imgJobs.trivy;
  if (!isRecord(trivy)) {
    errors.push(`${IMAGES_WORKFLOW}: job 'trivy' is missing`);
  } else {
    const body = JSON.stringify(trivy);
    if (!body.includes('images.json')) errors.push('trivy job must read digests from images.json');
    if (!body.includes('@sha256:'))
      errors.push('trivy job must refuse images not pinned by digest');
    if (!body.includes('ignore-unfixed')) errors.push('trivy job must set ignore-unfixed');
    if (!body.includes('upload-sarif')) errors.push('trivy job must upload SARIF');
    if (!body.includes('BW_ONLINE')) errors.push('trivy job must be gated on BW_ONLINE');
    const perms = isRecord(trivy.permissions) ? trivy.permissions : {};
    if (perms['security-events'] !== 'write') errors.push('trivy job needs security-events: write');
    if (perms.packages === 'write') errors.push('trivy job must not hold packages: write');
  }
  for (const [name, job] of Object.entries(jobs)) {
    const perms = isRecord(job) && isRecord(job.permissions) ? job.permissions : {};
    if (perms.packages === 'write')
      errors.push(`${WORKFLOW}: ${name} must not hold packages: write`);
  }
  return errors;
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | undefined}
 */
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const [cmd = ''] = argv;
  if (cmd === 'ignore') {
    const file = flag(argv, '--file') ?? IGNORE_FILE;
    const today = flag(argv, '--today') ?? isoDate(new Date());
    if (!existsSync(file)) {
      console.error(`${file} is missing`);
      return 1;
    }
    const { entries, errors } = validateIgnore(readFileSync(file, 'utf8'), today);
    for (const e of errors) console.error(`::error::${e}`);
    console.log(`${String(entries.length)} allowlist entries, ${String(errors.length)} problem(s)`);
    return errors.length > 0 ? 1 : 0;
  }
  if (cmd === 'summary') {
    const sarif = flag(argv, '--sarif');
    const label = flag(argv, '--label') ?? 'scan';
    if (sarif === undefined || !existsSync(sarif)) {
      console.error('--sarif <file> is required and must exist');
      return 1;
    }
    const r = summarizeSarif(readFileSync(sarif, 'utf8'));
    if (r.error !== undefined) {
      console.error(`::error::${r.error}`);
      return 1;
    }
    const line = summaryLine(label, r.counts, r.total);
    console.log(line);
    const out = flag(argv, '--summary');
    if (out !== undefined) appendFileSync(out, `${line}\n`);
    return 0;
  }
  if (cmd === 'wiring') {
    const errors = checkWiring(path.resolve(flag(argv, '--root') ?? '.'));
    for (const e of errors) console.error(`::error::${e}`);
    console.log(
      errors.length === 0 ? 'trivy wiring ok' : `${String(errors.length)} wiring problem(s)`,
    );
    return errors.length > 0 ? 1 : 0;
  }
  console.error('usage: check-trivy.mjs ignore|summary|wiring');
  return 2;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
