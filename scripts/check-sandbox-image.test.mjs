// Tests for the bw-sandbox Dockerfile guard (IMAGE-001, #599).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SANDBOX_DOCKERFILE,
  SANDBOX_DOCKERIGNORE,
  SANDBOX_TOOLS_PIN,
  WORKSPACE_MANIFEST,
  checkBrowserPin,
  checkRepo,
  checkSandboxDockerfile,
  checkToolsPin,
} from './check-sandbox-image.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const df = readFileSync(path.join(REPO_ROOT, SANDBOX_DOCKERFILE), 'utf8');
const ig = readFileSync(path.join(REPO_ROOT, SANDBOX_DOCKERIGNORE), 'utf8');
const workspace = readFileSync(path.join(REPO_ROOT, WORKSPACE_MANIFEST), 'utf8');
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
        e.includes('copy the pinned toolchain'),
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

  it('expects exactly four stages (builder, gotool, tools, runtime)', () => {
    assert.ok(errs(`${df}\nFROM \${NODE_IMAGE} AS extra\n`).some((e) => e.includes('four stages')));
  });
  it('requires the Go toolchain stage and a digest-pinned GO_IMAGE', () => {
    assert.ok(
      errs(df.replace(/^FROM \S+ AS gotool$/m, 'FROM ${NODE_IMAGE} AS other')).some((e) =>
        e.includes('gotool'),
      ),
    );
    assert.ok(
      errs(df.replace(/^ARG GO_IMAGE=.*$/m, 'ARG GO_IMAGE=golang:1.26')).some((e) =>
        e.includes('GO_IMAGE'),
      ),
    );
  });

  it('requires the runtime stage to install the pinned browser', () => {
    const step = 'RUN sh /pin/install-browser.sh /pin/tools.pin.json /app \\\n && rm -rf /pin';
    assert.ok(df.includes(step));
    assert.ok(errs(df.replace(step, 'RUN true')).some((e) => e.includes('install-browser.sh')));
    // A browser step placed before the runtime stage would never reach the runtime image.
    const early = df.replace(step, '').replace(/^FROM \S+ AS builder$/m, `${step}\n$&`);
    assert.ok(errs(early).some((e) => e.includes('install-browser.sh')));
  });

  it('sets PLAYWRIGHT_BROWSERS_PATH to the root-owned browser directory', () => {
    assert.ok(
      errs(
        df.replace('PLAYWRIGHT_BROWSERS_PATH=/opt/bw/browsers', 'PLAYWRIGHT_BROWSERS_PATH=/tmp'),
      ).some((e) => e.includes('PLAYWRIGHT_BROWSERS_PATH')),
    );
  });

  it('requires install-browser.sh to be allow-listed in the dockerignore', () => {
    assert.ok(
      errs(df, ig.replace('!infra/docker/sandbox/install-browser.sh\n', '')).some((e) =>
        e.includes('install-browser.sh'),
      ),
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
    assert.ok(
      errs(df, ig.replace('!infra/docker/sandbox/scanners.pin.json\n', '')).some((e) =>
        e.includes('scanners.pin.json'),
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

describe('checkBrowserPin', () => {
  const pinText = readFileSync(path.join(REPO_ROOT, SANDBOX_TOOLS_PIN), 'utf8');
  /** @typedef {{ browser: { playwright: string, playwrightMcp: string, licence: string, chromium: { version: string, revision: string } }, fonts: { package: string, version: string }[] }} BrowserPin */
  const parsed = /** @type {unknown} */ (JSON.parse(pinText));
  const pin = /** @type {BrowserPin} */ (parsed);
  /** @param {unknown} obj @param {string} [ws] */
  const pinErrs = (obj, ws = workspace) =>
    checkBrowserPin(typeof obj === 'string' ? obj : JSON.stringify(obj), ws);
  /** @param {(p: BrowserPin) => void} edit */
  const edited = (edit) => {
    const copy = structuredClone(pin);
    edit(copy);
    return copy;
  };
  /** @param {BrowserPin} p @param {Partial<BrowserPin['fonts'][number]>} change */
  const withFirstFont = (p, change) => p.fonts.map((f, i) => (i === 0 ? { ...f, ...change } : f));

  it('accepts the committed pin and matches the workspace catalog', () => {
    assert.deepEqual(checkBrowserPin(pinText, workspace), []);
  });

  it('rejects text that is not JSON', () => {
    assert.ok(pinErrs('{').some((e) => e.includes('not valid JSON')));
  });

  it('requires a browser object', () => {
    assert.ok(
      pinErrs(edited((p) => Reflect.deleteProperty(p, 'browser'))).some((e) =>
        e.includes('"browser"'),
      ),
    );
  });

  it('rejects a Playwright or MCP pin that differs from the workspace catalog', () => {
    assert.ok(
      pinErrs(edited((p) => (p.browser.playwright = '1.62.0'))).some((e) =>
        e.includes('playwright-core'),
      ),
    );
    assert.ok(
      pinErrs(edited((p) => (p.browser.playwrightMcp = '0.0.79'))).some((e) =>
        e.includes('@playwright/mcp'),
      ),
    );
  });

  it('fails when the workspace catalog has no Playwright pin at all', () => {
    const noCatalog = workspace.replace(/playwright-core: .*\n/, '');
    assert.ok(pinErrs(pin, noCatalog).some((e) => e.includes('playwright-core')));
  });

  it('rejects a floating or inexact Playwright version', () => {
    assert.ok(
      pinErrs(edited((p) => (p.browser.playwright = '^1.63.0'))).some((e) =>
        e.includes('exact semver'),
      ),
    );
  });

  it('requires an exact Chromium version and a numeric revision', () => {
    assert.ok(
      pinErrs(edited((p) => (p.browser.chromium.version = '153'))).some((e) =>
        e.includes('chromium.version'),
      ),
    );
    assert.ok(
      pinErrs(edited((p) => (p.browser.chromium.revision = 'latest'))).some((e) =>
        e.includes('chromium.revision'),
      ),
    );
  });

  it('rejects a licence other than Apache-2.0', () => {
    assert.ok(
      pinErrs(edited((p) => (p.browser.licence = 'GPL-3.0'))).some((e) => e.includes('Apache-2.0')),
    );
  });

  it('requires the Noto font packages to be pinned', () => {
    assert.ok(
      pinErrs(
        edited((p) => (p.fonts = p.fonts.filter((f) => f.package !== 'fonts-noto-cjk'))),
      ).some((e) => e.includes('fonts-noto-cjk')),
    );
    assert.ok(pinErrs(edited((p) => (p.fonts = []))).some((e) => e.includes('"fonts" array')));
  });

  it('rejects a font version that is not an exact Debian version', () => {
    for (const version of ['latest', '', '*']) {
      assert.ok(
        pinErrs(edited((p) => (p.fonts = withFirstFont(p, { version })))).some((e) =>
          e.includes('exact Debian version'),
        ),
        version,
      );
    }
  });

  it('rejects an invalid font package name', () => {
    assert.ok(
      pinErrs(
        edited((p) => (p.fonts = withFirstFont(p, { package: 'fonts-noto-core; rm -rf /' }))),
      ).some((e) => e.includes('package name')),
    );
  });
});
