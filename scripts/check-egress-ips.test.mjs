// Tests for the egress-IP list validator and drift check (INFRA-015, #50).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { driftErrors, isNonPublic, load, main, validateDocument } from './check-egress-ips.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'bw-egress-ips-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const good = () => ({
  version: 1,
  lastUpdated: '2026-10-20T10:00:00Z',
  egressIps: ['198.51.100.7/32', '203.0.113.20/32'],
  notes: 'allowlist these',
});

describe('validateDocument', () => {
  it('accepts a well-formed v1 document', () => {
    assert.deepEqual(validateDocument(good()), []);
  });

  it('rejects wrong version, bad timestamp, extra and missing fields', () => {
    assert.match(validateDocument({ ...good(), version: 2 }).join(), /version must be 1/);
    assert.match(validateDocument({ ...good(), lastUpdated: 'yesterday' }).join(), /lastUpdated/);
    assert.match(validateDocument({ ...good(), lastUpdated: '2026-10-20T10:00:00+02:00' }).join(), /lastUpdated/);
    assert.match(validateDocument({ ...good(), extra: 1 }).join(), /unexpected field "extra"/);
    assert.match(validateDocument({ ...good(), notes: undefined }).join(), /notes/);
    assert.match(validateDocument([]).join(), /JSON object/);
  });

  it('requires a non-empty list of /32 CIDRs without duplicates', () => {
    assert.match(validateDocument({ ...good(), egressIps: [] }).join(), /non-empty/);
    assert.match(validateDocument({ ...good(), egressIps: ['203.0.113.20'] }).join(), /\/32/);
    assert.match(validateDocument({ ...good(), egressIps: ['203.0.113.0/24'] }).join(), /\/32/);
    assert.match(validateDocument({ ...good(), egressIps: ['300.0.113.1/32'] }).join(), /octet/);
    assert.match(
      validateDocument({ ...good(), egressIps: ['203.0.113.20/32', '203.0.113.20/32'] }).join(),
      /duplicated/,
    );
  });

  it('never allows RFC1918, loopback, link-local, CGNAT or multicast addresses', () => {
    for (const ip of [
      '10.40.1.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '0.0.0.0',
    ]) {
      assert.match(
        validateDocument({ ...good(), egressIps: [`${ip}/32`] }).join(),
        /not a public address/,
        ip,
      );
    }
  });

  it('treats the boundaries of the private ranges correctly', () => {
    assert.equal(isNonPublic([172, 15, 0, 1]), false);
    assert.equal(isNonPublic([172, 32, 0, 1]), false);
    assert.equal(isNonPublic([100, 128, 0, 1]), false);
    assert.equal(isNonPublic([203, 0, 113, 1]), false);
  });
});

describe('driftErrors', () => {
  it('passes when the published set equals the tofu output, in any order', () => {
    assert.deepEqual(driftErrors(good(), ['203.0.113.20', '198.51.100.7']), []);
  });

  it('fails when an EIP changed and the document was not republished', () => {
    const errs = driftErrors(good(), ['203.0.113.20', '198.51.100.99']).join('\n');
    assert.match(errs, /198\.51\.100\.99\/32 is an egress EIP but is not published/);
    assert.match(errs, /198\.51\.100\.7\/32 is published but is not an egress EIP/);
  });

  it('fails on a malformed tofu output', () => {
    assert.match(driftErrors(good(), { a: 1 }).join(), /JSON array/);
  });
});

describe('cli', () => {
  const write = (name, value) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  it('exits 0 for a valid document and 1 for a drifted one', async () => {
    const doc = write('doc.json', good());
    const ok = write('ok.json', ['198.51.100.7', '203.0.113.20']);
    const bad = write('bad.json', ['198.51.100.7']);
    assert.equal(await main(['validate', doc]), 0);
    assert.equal(await main(['drift', doc, ok]), 0);
    assert.equal(await main(['drift', doc, bad]), 1);
  });

  it('refuses plain http sources and prints usage for bad arguments', async () => {
    await assert.rejects(load('http://egress.example/x.json'), /plain http/);
    assert.equal(await main(['validate', 'http://egress.example/x.json']), 1);
    assert.equal(await main([]), 2);
  });
});

describe('environment wiring', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  for (const env of ['dev', 'staging', 'prod']) {
    it(`${env} feeds the module only from module.vpc.egress_ips`, () => {
      const text = readFileSync(
        path.join(root, 'infra/tofu/environments', env, 'egress_ips.tf'),
        'utf8',
      );
      assert.match(text, /^\s*egress_ips\s*=\s*module\.vpc\.egress_ips\s*$/m);
      // No hand-written address may appear in the wiring.
      assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    });
  }
});
