// Tests for the bw-sandbox Dockerfile guard (IMAGE-001, #599).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SANDBOX_DOCKERFILE,
  SANDBOX_DOCKERIGNORE,
  SANDBOX_TOOLS_PIN,
  checkRepo,
  checkSandboxDockerfile,
  checkToolsPin,
} from './check-sandbox-image.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const df = readFileSync(path.join(REPO_ROOT, SANDBOX_DOCKERFILE), 'utf8');
const ig = readFileSync(path.join(REPO_ROOT, SANDBOX_DOCKERIGNORE), 'utf8');
/** @param {string} d @param {string} [i] */
const errs = (d, i = ig) => checkSandboxDockerfile(d, i);

describe('real repository', () => {
  it('passes the guard', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
  });
});

describe('checkSandboxDockerfile', () => {
  it('rejects a floating or digest-less base image', () => {
    const bad = df.replace(/@sha256:[0-9a-f]{64}/, '');
    assert.ok(errs(bad).some((e) => e.includes('digest')));
    assert.ok(errs(df.replace(/@sha256:[0-9a-f]{64}/, ':latest')).length > 0);
  });

  it('rejects running as root (USER removed or final USER root)', () => {
    assert.ok(errs(df.replace(/^USER bw:bw$/m, 'USER root')).some((e) => e.includes('final USER')));
    assert.ok(errs(df.replace(/^USER bw:bw$/m, '')).some((e) => e.includes('USER')));
  });

  it('rejects a user appended after USER bw', () => {
    assert.ok(errs(`${df}\nUSER root\n`).some((e) => e.includes('final USER')));
  });

  it('requires uid/gid 10001', () => {
    assert.ok(errs(df.replaceAll('10001', '1000')).some((e) => e.includes('10001')));
  });

  it('requires the standard directories, env defaults and healthcheck', () => {
    assert.ok(errs(df.replaceAll('/opt/bw/wordlists', '/x')).some((e) => e.includes('wordlists')));
    assert.ok(errs(df.replace('BW_SANDBOX=1', 'BW_X=1')).some((e) => e.includes('BW_SANDBOX')));
    assert.ok(
      errs(df.replace(/^HEALTHCHECK /m, '# HEALTHCHECK ')).some((e) => e.includes('HEALTHCHECK')),
    );
  });

  it('rejects secrets in ENV', () => {
    assert.ok(
      errs(df.replace('BW_SANDBOX=1', 'BW_SANDBOX=1 ANTHROPIC_API_KEY=x')).some((e) =>
        e.includes('secrets'),
      ),
    );
  });

  it('requires an allow-list dockerignore', () => {
    assert.ok(errs(df, '.git\n').some((e) => e.includes('dockerignore')));
  });

  it('requires the tools stage to install the pinned binaries', () => {
    assert.ok(
      errs(df.replace(/^FROM \S+ AS tools$/m, 'FROM ${NODE_IMAGE} AS other')).some((e) =>
        e.includes('tools stage'),
      ),
    );
    assert.ok(
      errs(
        df.replace(
          'RUN sh /pin/install-tools.sh /pin/tools.pin.json /opt/bw/tools/bin',
          'RUN true',
        ),
      ).some((e) => e.includes('install-tools.sh')),
    );
  });

  it('requires the runtime stage to copy the binaries from the tools stage', () => {
    assert.ok(
      errs(df.replace('COPY --from=tools', 'COPY --from=builder')).some((e) =>
        e.includes('copy the pinned binaries'),
      ),
    );
  });

  it('keeps the tools directory root-owned so bw cannot replace a binary', () => {
    assert.ok(
      errs(
        df.replace(
          'chown -R bw:bw /opt/bw/templates',
          'chown -R bw:bw /opt/bw/tools/bin /opt/bw/templates',
        ),
      ).some((e) => e.includes('root-owned')),
    );
  });

  it('expects exactly three stages', () => {
    assert.ok(
      errs(`${df}\nFROM \${NODE_IMAGE} AS extra\n`).some((e) => e.includes('three stages')),
    );
  });

  it('requires the tools inputs to be allow-listed in the dockerignore', () => {
    assert.ok(
      errs(df, ig.replace('!infra/docker/sandbox/install-tools.sh\n', '')).some((e) =>
        e.includes('install-tools.sh'),
      ),
    );
    assert.ok(
      errs(df, ig.replace('!infra/docker/sandbox/tools.pin.json\n', '')).some((e) =>
        e.includes('tools.pin.json'),
      ),
    );
  });
});

describe('checkToolsPin', () => {
  const pinText = readFileSync(path.join(REPO_ROOT, SANDBOX_TOOLS_PIN), 'utf8');
  /** @type {unknown} */
  const rawPin = JSON.parse(pinText);
  const pin = /** @type {import('./check-sandbox-image.mjs').ToolsPin} */ (rawPin);
  /** @param {string} name @param {Record<string, unknown>} patch */
  const withTool = (name, patch) => ({
    ...pin,
    tools: pin.tools.map((/** @type {{name: string}} */ t) =>
      t.name === name ? { ...t, ...patch } : t,
    ),
  });
  /** @param {unknown} obj */
  const pinErrs = (obj) => checkToolsPin(typeof obj === 'string' ? obj : JSON.stringify(obj));

  it('accepts the committed pin', () => {
    assert.deepEqual(checkToolsPin(pinText), []);
  });

  it('rejects text that is not JSON', () => {
    assert.ok(pinErrs('{').some((e) => e.includes('not valid JSON')));
  });

  it('rejects a pin without a tools array', () => {
    assert.ok(pinErrs({}).some((e) => e.includes('"tools" array')));
  });

  it('requires all six tools', () => {
    const without = {
      ...pin,
      tools: pin.tools.filter((/** @type {{name: string}} */ t) => t.name !== 'nuclei'),
    };
    assert.ok(pinErrs(without).some((e) => e.includes('missing nuclei')));
  });

  it('rejects a duplicated or unknown tool', () => {
    const first = pin.tools[0];
    assert.ok(first);
    assert.ok(pinErrs({ ...pin, tools: [...pin.tools, first] }).some((e) => e.includes('twice')));
    const evil = { ...first, name: 'evil' };
    assert.ok(
      pinErrs({ ...pin, tools: [...pin.tools, evil] }).some((e) => e.includes('unknown tool')),
    );
  });

  it('rejects a floating or inexact version', () => {
    assert.ok(pinErrs(withTool('dnsx', { version: 'latest' })).some((e) => e.includes('semver')));
    assert.ok(pinErrs(withTool('dnsx', { version: '1.3' })).some((e) => e.includes('semver')));
  });

  it('rejects an asset URL that is not the pinned linux/amd64 release', () => {
    const latest =
      'https://github.com/projectdiscovery/dnsx/releases/latest/download/dnsx_1.3.1_linux_amd64.zip';
    assert.ok(pinErrs(withTool('dnsx', { url: latest })).some((e) => e.includes('url must be')));
    const dnsxUrl = pin.tools.find((t) => t.name === 'dnsx')?.url;
    assert.ok(dnsxUrl);
    const http = dnsxUrl.replace('https://', 'http://');
    assert.ok(pinErrs(withTool('dnsx', { url: http })).some((e) => e.includes('url must be')));
  });

  it('rejects a missing, short or uppercase sha256', () => {
    for (const sha256 of [undefined, 'a'.repeat(63), 'A'.repeat(64)]) {
      assert.ok(
        pinErrs(withTool('httpx', { sha256 })).some((e) => e.includes('sha256')),
        String(sha256),
      );
    }
  });

  it('rejects a licence other than MIT', () => {
    assert.ok(pinErrs(withTool('katana', { licence: 'GPL-3.0' })).some((e) => e.includes('MIT')));
  });
});
