// Tests for the bw-sqlmap wrapper (IMAGE-002, #601): the only sqlmap entry point in the sandbox image.
// Every destructive or out-of-band option must be refused, and anything off the allow-list must fail closed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_OPTIONS,
  DENIED_OPTIONS,
  UsageError,
  buildSqlmapArgs,
} from '../infra/docker/sandbox/tools/bw-sqlmap.mjs';

const TARGET = ['-u', 'https://app.example.test/item?id=1'];

/**
 * @param {string[]} argv
 * @param {RegExp} pattern
 */
const refuse = (argv, pattern) => {
  /** @type {(err: unknown) => boolean} */
  const isRefusal = (err) => err instanceof UsageError && pattern.test(err.message);
  assert.throws(() => buildSqlmapArgs(argv), isRefusal, `expected refusal for ${argv.join(' ')}`);
};

describe('bw-sqlmap: destructive and out-of-band options are refused', () => {
  for (const flag of Object.keys(DENIED_OPTIONS)) {
    it(`refuses ${flag}`, () => {
      refuse([...TARGET, flag], new RegExp(`refused ${flag.replace(/-/g, '\\-')}`));
    });
  }

  it('refuses the inline --os-shell=value form too', () => {
    refuse([...TARGET, '--os-shell=1'], /refused --os-shell/);
  });

  it('refuses the abbreviated names optparse would otherwise accept', () => {
    refuse([...TARGET, '--os-s'], /not on the bw-sqlmap allow-list/);
    refuse([...TARGET, '--file-w'], /not on the bw-sqlmap allow-list/);
  });

  it('refuses stacked and inline techniques (S, Q) and risk 3 (UPDATE statements)', () => {
    refuse([...TARGET, '--technique', 'S'], /--technique must be/);
    refuse([...TARGET, '--technique=BEUTSQ'], /--technique must be/);
    refuse([...TARGET, '--risk', '3'], /--risk must be/);
  });
});

describe('bw-sqlmap: allow-list and value checks', () => {
  it('refuses any option not on the allow-list (fail closed)', () => {
    refuse([...TARGET, '--eval-not-real'], /not on the bw-sqlmap allow-list/);
    refuse([...TARGET, '--tamper', 'space2comment'], /not on the bw-sqlmap allow-list/);
    refuse([...TARGET, '--os-cmd-x'], /not on the bw-sqlmap allow-list/);
  });

  it('refuses positional arguments', () => {
    refuse([...TARGET, 'extra'], /unexpected argument "extra"/);
  });

  it('refuses an option given twice', () => {
    refuse([...TARGET, '-u', 'https://other.example.test'], /given more than once/);
  });

  it('requires a target URL unless asked for --version', () => {
    refuse(['--banner'], /target URL \(-u or --url\) is required/);
    refuse(['-u'], /needs a value/);
  });

  it('requires an http(s) target and a proxy URL with an allowed scheme', () => {
    refuse(['-u', 'file:///etc/passwd'], /-u must be an http\(s\) URL/);
    refuse(['-u', 'ftp://x.example.test/'], /-u must be an http\(s\) URL/);
    refuse([...TARGET, '--proxy', 'gopher://127.0.0.1:70'], /--proxy must be/);
  });

  it('rejects a value that looks like an option (no smuggling of flags as values)', () => {
    refuse(['-u', '--os-shell'], /must not look like an option/);
    refuse(['-u', 'https://app.example.test/', '-p', '--batch'], /must not look like an option/);
  });

  it('bounds numeric options', () => {
    refuse([...TARGET, '--level', '6'], /--level must be/);
    refuse([...TARGET, '--threads', '5'], /--threads must be/);
    refuse([...TARGET, '--delay', '0.1'], /--delay must be/);
    refuse([...TARGET, '--delay', 'soon'], /--delay must be/);
    refuse([...TARGET, '--retries', '-1'], /must not look like an option|--retries must be/);
  });

  it('refuses a flag that takes no value when given one', () => {
    refuse([...TARGET, '--banner=yes'], /--banner takes no value/);
  });

  it('refuses a flag that needs a value when none is given', () => {
    refuse([...TARGET, '--level'], /--level needs a value/);
  });

  it('keeps the whole allow-list valid, so each option has a checker or takes no value', () => {
    for (const [name, spec] of Object.entries(ALLOWED_OPTIONS)) {
      assert.ok(name.startsWith('-'), name);
      assert.ok(spec.kind === 'none' || typeof spec.check === 'function', name);
      assert.equal(DENIED_OPTIONS[name], undefined, `${name} is both allowed and denied`);
    }
  });
});

describe('bw-sqlmap: accepted invocations', () => {
  it('forces batch mode, disables colouring and rate-limits by default', () => {
    const args = buildSqlmapArgs([...TARGET, '--banner']);
    assert.deepEqual(args.slice(0, 2), ['--batch', '--disable-coloring']);
    assert.deepEqual(args.slice(-4), ['--delay', '1', '--threads', '1']);
  });

  it('passes an explicit delay and thread count through instead of the defaults', () => {
    const args = buildSqlmapArgs([...TARGET, '--delay=2.5', '--threads', '3', '--level', '2']);
    assert.equal(args.filter((a) => a === '--delay').length, 1);
    assert.equal(args[args.indexOf('--delay') + 1], '2.5');
    assert.equal(args[args.indexOf('--threads') + 1], '3');
    assert.equal(args[args.indexOf('--level') + 1], '2');
  });

  it('accepts the read-only detection set', () => {
    const args = buildSqlmapArgs([
      ...TARGET,
      '-p',
      'id',
      '--dbms',
      'MySQL',
      '--technique',
      'BEUT',
      '--risk',
      '2',
      '--level',
      '3',
      '--current-user',
      '--current-db',
      '--is-dba',
      '--proxy',
      'http://egress.bw.internal:3128',
    ]);
    assert.ok(args.includes('--is-dba'));
    assert.equal(args[args.indexOf('--proxy') + 1], 'http://egress.bw.internal:3128');
  });

  it('answers --version alone, without the target or forced flags', () => {
    assert.deepEqual(buildSqlmapArgs(['--version']), ['--version']);
  });
});
