#!/usr/bin/env node
// bw-sqlmap: the only sqlmap entry point in the bw-sandbox image (IMAGE-002, #601). The raw sqlmap
// tree lives under /opt/bw/tools/lib (not on PATH) and runs as a separate python3 process. This wrapper
// accepts an allow-list of detection and read-only options, refuses every destructive or out-of-band
// option, and forces batch mode and rate limits. Anything not on the list is refused (fail closed).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQLMAP_ENTRY = '/opt/bw/tools/lib/sqlmap/sqlmap.py';
const EX_USAGE = 64;
const DEFAULT_DELAY_SECONDS = '1';
const DEFAULT_THREADS = '1';
const MAX_VALUE_CHARS = 4096;
const MAX_USER_AGENT_CHARS = 256;
const MAX_LEVEL = 5;
const MAX_RETRIES = 3;
const MAX_THREADS = 4;
const MAX_VERBOSITY = 6;
const MIN_DELAY_SECONDS = 0.5;
const MAX_DELAY_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 120;
const FORCED_FLAGS = Object.freeze(['--batch', '--disable-coloring']);

/** Options that are refused outright, with a reason. Every name here also fails the allow-list. */
/** @type {Readonly<Record<string, string>>} */
export const DENIED_OPTIONS = Object.freeze({
  '--os-shell': 'OS command shell',
  '--os-cmd': 'OS command execution',
  '--os-pwn': 'OS takeover',
  '--os-smbrelay': 'SMB relay',
  '--os-bof': 'buffer overflow exploitation',
  '--priv-esc': 'privilege escalation',
  '--sql-shell': 'interactive SQL shell',
  '--sql-query': 'arbitrary SQL statements',
  '--file-read': 'reading target files',
  '--file-write': 'writing target files',
  '--file-dest': 'writing target files',
  '--file-upload': 'uploading files to the target',
  '--udf-inject': 'user-defined function injection',
  '--shared-lib': 'shared library injection',
  '--reg-add': 'registry writes',
  '--reg-del': 'registry deletes',
  '--second-url': 'second-order out-of-band requests',
  '--eval': 'arbitrary Python evaluation',
  '--dump-all': 'bulk data dump',
  '--dump': 'data dump',
  '--sqlmap-shell': 'interactive sqlmap shell',
});

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** @param {string} v */
const isUrl = (v) => /^(https?:\/\/[^\s]+|socks[45]h?:\/\/[^\s]+)$/.test(v);
/** @param {string} v */
const isHttpUrl = (v) => /^https?:\/\/[^\s]+$/.test(v);
/** @param {string} v */
const isIdent = (v) => /^[\w$.-]{1,64}$/.test(v);

/**
 * @param {number} min
 * @param {number} max
 * @returns {(v: string) => boolean}
 */
const intIn = (min, max) => (v) => {
  if (!/^\d+$/.test(v)) return false;
  const n = Number(v);
  return n >= min && n <= max;
};

/**
 * @param {number} min
 * @param {number} max
 * @returns {(v: string) => boolean}
 */
const numIn = (min, max) => (v) => {
  if (!/^\d+(\.\d+)?$/.test(v)) return false;
  const n = Number(v);
  return n >= min && n <= max;
};

/**
 * @typedef {{ kind: 'none' } | { kind: 'value', check: (v: string) => boolean, expect: string }} OptionSpec
 */
/**
 * Allow-listed options. `kind: 'none'` takes no value; `'value'` takes one checked value.
 * @type {Readonly<Record<string, OptionSpec>>}
 */
export const ALLOWED_OPTIONS = Object.freeze({
  '--version': { kind: 'none' },
  '-u': { kind: 'value', check: isHttpUrl, expect: 'an http(s) URL' },
  '--url': { kind: 'value', check: isHttpUrl, expect: 'an http(s) URL' },
  '-d': {
    kind: 'value',
    check: (v) => v.length > 0 && v.length <= MAX_VALUE_CHARS,
    expect: 'POST data (<= 4096 chars)',
  },
  '--data': {
    kind: 'value',
    check: (v) => v.length > 0 && v.length <= MAX_VALUE_CHARS,
    expect: 'POST data (<= 4096 chars)',
  },
  '-p': { kind: 'value', check: isIdent, expect: 'a parameter name' },
  '--cookie': {
    kind: 'value',
    check: (v) => v.length > 0 && v.length <= MAX_VALUE_CHARS,
    expect: 'a cookie header',
  },
  '--headers': {
    kind: 'value',
    check: (v) => v.length > 0 && v.length <= MAX_VALUE_CHARS,
    expect: 'extra headers',
  },
  '--user-agent': {
    kind: 'value',
    check: (v) => v.length > 0 && v.length <= MAX_USER_AGENT_CHARS,
    expect: 'a user agent',
  },
  '--method': {
    kind: 'value',
    check: (v) => /^(GET|POST|PUT|PATCH)$/.test(v),
    expect: 'GET, POST, PUT or PATCH',
  },
  '--proxy': { kind: 'value', check: isUrl, expect: 'an http, https or socks proxy URL' },
  '--level': { kind: 'value', check: intIn(1, MAX_LEVEL), expect: `an integer 1-${MAX_LEVEL}` },
  '--risk': {
    kind: 'value',
    check: intIn(1, 2),
    expect: 'an integer 1-2 (risk 3 can issue UPDATE statements)',
  },
  '--technique': {
    kind: 'value',
    check: (v) => /^[BEUT]{1,4}$/.test(v),
    expect: 'B, E, U and/or T (no stacked S or inline Q)',
  },
  '--dbms': { kind: 'value', check: (v) => /^[A-Za-z0-9 ]{1,40}$/.test(v), expect: 'a DBMS name' },
  '--delay': {
    kind: 'value',
    check: numIn(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS),
    expect: `seconds between ${MIN_DELAY_SECONDS} and ${MAX_DELAY_SECONDS}`,
  },
  '--timeout': {
    kind: 'value',
    check: numIn(1, MAX_TIMEOUT_SECONDS),
    expect: `seconds between 1 and ${MAX_TIMEOUT_SECONDS}`,
  },
  '--retries': {
    kind: 'value',
    check: intIn(0, MAX_RETRIES),
    expect: `an integer 0-${MAX_RETRIES}`,
  },
  '--threads': {
    kind: 'value',
    check: intIn(1, MAX_THREADS),
    expect: `an integer 1-${MAX_THREADS}`,
  },
  '-v': { kind: 'value', check: intIn(0, MAX_VERBOSITY), expect: `a verbosity 0-${MAX_VERBOSITY}` },
  '-D': { kind: 'value', check: isIdent, expect: 'a database name' },
  '-T': { kind: 'value', check: isIdent, expect: 'a table name' },
  '-C': { kind: 'value', check: isIdent, expect: 'a column name' },
  '--random-agent': { kind: 'none' },
  '--force-ssl': { kind: 'none' },
  '--banner': { kind: 'none' },
  '--current-user': { kind: 'none' },
  '--current-db': { kind: 'none' },
  '--is-dba': { kind: 'none' },
  '--dbs': { kind: 'none' },
  '--tables': { kind: 'none' },
  '--columns': { kind: 'none' },
});

/**
 * Validates the caller's arguments and returns the argv for the raw sqlmap process. Pure, so the unit tests
 * drive it directly. Throws UsageError on the first refused token.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function buildSqlmapArgs(argv) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? '';
    i += 1;
    if (!token.startsWith('-')) throw new UsageError(`unexpected argument "${token}"`);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const denied = DENIED_OPTIONS[name];
    if (denied !== undefined) throw new UsageError(`refused ${name}: ${denied} is not allowed`);
    const spec = ALLOWED_OPTIONS[name];
    if (spec === undefined)
      throw new UsageError(`option ${name} is not on the bw-sqlmap allow-list`);
    if (seen.has(name)) throw new UsageError(`option ${name} given more than once`);
    seen.add(name);

    if (spec.kind === 'none') {
      if (inline !== undefined) throw new UsageError(`${name} takes no value`);
      out.push(name);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = argv[i];
      if (value === undefined) throw new UsageError(`${name} needs a value (${spec.expect})`);
      if (value.startsWith('-')) throw new UsageError(`${name} value must not look like an option`);
      i += 1;
    }
    if (!spec.check(value)) throw new UsageError(`${name} must be ${spec.expect}`);
    out.push(name, value);
  }

  if (out.includes('--version')) return ['--version'];
  if (!seen.has('-u') && !seen.has('--url'))
    throw new UsageError('a target URL (-u or --url) is required');
  if (!seen.has('--delay')) out.push('--delay', DEFAULT_DELAY_SECONDS);
  if (!seen.has('--threads')) out.push('--threads', DEFAULT_THREADS);
  return [...FORCED_FLAGS, ...out];
}

/** @param {string[]} argv */
function main(argv) {
  let args;
  try {
    args = buildSqlmapArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`bw-sqlmap: ${err.message}\n`);
      process.exitCode = EX_USAGE;
      return;
    }
    throw err;
  }
  const child = spawn('python3', [SQLMAP_ENTRY, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  child.on('error', (err) => {
    process.stderr.write(`bw-sqlmap: cannot start sqlmap: ${err.message}\n`);
    process.exitCode = 1;
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main(process.argv.slice(2));
