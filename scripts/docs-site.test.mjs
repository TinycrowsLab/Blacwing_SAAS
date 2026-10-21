// Self-tests for scripts/docs-site.mjs (DOCS-001, #813). Run with `pnpm test:scripts`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VERSION,
  buildSite,
  checkExternalLinks,
  checkLinks,
  checkNavigation,
  collectProblems,
  escapeHtml,
  parseArgs,
  parseSiteConfig,
  renderMarkdown,
  resolveHref,
  writeVersionIndex,
} from './docs-site.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string[]} */
const tempRoots = [];

after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes a docs tree into a fresh temp root. `files` maps repo paths to contents.
 * @param {Record<string, string>} files
 * @returns {string} the root
 */
function makeRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'docs-site-'));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/**
 * A valid config that lists the given pages in one section.
 * @param {string[]} pages
 * @param {Record<string, unknown>} [extra]
 */
function config(pages, extra = {}) {
  return {
    title: 'Test docs',
    sections: [{ title: 'Guide', pages }],
    ...extra,
  };
}

describe('parseSiteConfig', () => {
  it('accepts a valid config and returns the ignore set', () => {
    const parsed = parseSiteConfig(config(['user/a.md'], { linkCheck: { ignoreTargets: ['…'] } }));
    assert.equal(parsed.title, 'Test docs');
    assert.deepEqual(parsed.sections, [{ title: 'Guide', pages: ['user/a.md'] }]);
    assert.ok(parsed.ignoreTargets.has('…'));
  });

  it('rejects a non-object document', () => {
    assert.throws(() => parseSiteConfig(['x']), /must be a JSON object/);
    assert.throws(() => parseSiteConfig(null), /must be a JSON object/);
  });

  it('rejects an empty title and an empty section list', () => {
    assert.throws(() => parseSiteConfig({ title: ' ', sections: [{}] }), /title/);
    assert.throws(() => parseSiteConfig({ title: 'x', sections: [] }), /sections must be/);
  });

  it('rejects a section without a title or without pages', () => {
    assert.throws(
      () => parseSiteConfig({ title: 'x', sections: [{ title: '', pages: ['a.md'] }] }),
      /title must be/,
    );
    assert.throws(
      () => parseSiteConfig({ title: 'x', sections: [{ title: 'S', pages: [] }] }),
      /pages must be a non-empty array/,
    );
  });

  it('rejects pages that are not relative Markdown files', () => {
    assert.throws(() => parseSiteConfig(config(['a.html'])), /relative \.md path/);
    assert.throws(() => parseSiteConfig(config(['/etc/a.md'])), /relative \.md path/);
    const numericPages = /** @type {unknown} */ ([42]);
    assert.throws(
      () =>
        parseSiteConfig({
          title: 'Test docs',
          sections: [{ title: 'Guide', pages: numericPages }],
        }),
      /relative \.md path/,
    );
  });

  it('rejects a page path that escapes docs/', () => {
    assert.throws(() => parseSiteConfig(config(['../../CLAUDE.md'])), /escapes docs/);
  });

  it('rejects a malformed ignore list', () => {
    assert.throws(
      () => parseSiteConfig(config(['a.md'], { linkCheck: { ignoreTargets: 'x' } })),
      /ignoreTargets must be an array of strings/,
    );
  });
});

describe('resolveHref', () => {
  it('classifies web and mail links as external', () => {
    assert.deepEqual(resolveHref('https://example.com/x', 'a.md'), {
      kind: 'external',
      url: 'https://example.com/x',
    });
    assert.equal(resolveHref('mailto:ops@example.com', 'a.md').kind, 'external');
  });

  it('fails closed on every other scheme', () => {
    // The script URL is built from parts so the test source holds no script URL literal.
    const scriptUrl = ['javascript', ':alert(1)'].join('');
    for (const href of [scriptUrl, 'data:text/html,hi', 'file:///etc/passwd', 'ftp://x']) {
      assert.deepEqual(resolveHref(href, 'a.md'), { kind: 'invalid' }, href);
    }
  });

  it('treats a bare hash as a same-page anchor', () => {
    assert.deepEqual(resolveHref('#usage', 'user/a.md'), { kind: 'anchor', anchor: 'usage' });
  });

  it('resolves a relative Markdown link inside docs/ as a page', () => {
    assert.deepEqual(resolveHref('../runbooks/release.md#steps', 'user/a.md'), {
      kind: 'page',
      target: 'docs/runbooks/release.md',
      anchor: 'steps',
    });
  });

  it('resolves a root-relative link as repository-root relative', () => {
    assert.deepEqual(resolveHref('/CLAUDE.md', 'user/a.md'), {
      kind: 'repo',
      target: 'CLAUDE.md',
      anchor: '',
    });
  });

  it('resolves a repository file outside docs/ and an asset inside docs/ as repo links', () => {
    assert.equal(resolveHref('../../infra/versions.env', 'user/a.md').kind, 'repo');
    assert.deepEqual(resolveHref('../api/openapi.json', 'user/a.md'), {
      kind: 'repo',
      target: 'docs/api/openapi.json',
      anchor: '',
    });
  });

  it('rejects a link that climbs out of the repository', () => {
    assert.deepEqual(resolveHref('../../../../etc/passwd', 'user/a.md'), { kind: 'invalid' });
  });
});

describe('checkNavigation', () => {
  it('reports a navigation entry without a file', () => {
    const errors = checkNavigation(parseSiteConfig(config(['user/a.md', 'user/gone.md'])), [
      'user/a.md',
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /lists user\/gone\.md, which does not exist/);
  });

  it('fails a docs page that the navigation does not list', () => {
    const errors = checkNavigation(parseSiteConfig(config(['user/a.md'])), [
      'user/a.md',
      'user/b.md',
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /docs\/user\/b\.md: not in the site navigation/);
  });

  it('passes when the navigation and the pages match', () => {
    assert.deepEqual(
      checkNavigation(parseSiteConfig(config(['a.md', 'b/c.md'])), ['a.md', 'b/c.md']),
      [],
    );
  });
});

describe('checkLinks', () => {
  it('fails a link to a missing file', () => {
    const root = makeRepo({
      'docs/site.json': '{}',
      'docs/user/a.md': '# A\n\nSee [gone](../runbooks/nope.md).\n',
    });
    const { errors } = checkLinks(root, parseSiteConfig(config(['user/a.md'])), ['user/a.md']);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /broken link "\.\.\/runbooks\/nope\.md"/);
  });

  it('fails an anchor that matches no heading in the target page', () => {
    const root = makeRepo({
      'docs/user/a.md': '# A\n\nSee [b](b.md#missing).\n',
      'docs/user/b.md': '# B\n\n## Real section\n',
    });
    const { errors } = checkLinks(root, parseSiteConfig(config(['user/a.md', 'user/b.md'])), [
      'user/a.md',
      'user/b.md',
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /has no matching heading in docs\/user\/b\.md/);
  });

  it('accepts an anchor that matches a heading, including GitHub-style slugs', () => {
    const root = makeRepo({
      'docs/user/a.md': '# A\n\n[b](b.md#real-section) and [top](#a)\n',
      'docs/user/b.md': '# B\n\n## Real section\n',
    });
    const { errors } = checkLinks(root, parseSiteConfig(config(['user/a.md', 'user/b.md'])), [
      'user/a.md',
      'user/b.md',
    ]);
    assert.deepEqual(errors, []);
  });

  it('fails a same-page anchor with no heading', () => {
    const root = makeRepo({ 'docs/user/a.md': '# A\n\n[x](#nowhere)\n' });
    const { errors } = checkLinks(root, parseSiteConfig(config(['user/a.md'])), ['user/a.md']);
    assert.equal(errors.length, 1);
  });

  it('ignores links listed in linkCheck.ignoreTargets and links inside code', () => {
    const root = makeRepo({
      'docs/adr/template.md': '# T\n\n[ADR](NNNN-slug.md) and `[code](missing.md)`\n',
    });
    const cfg = parseSiteConfig(
      config(['adr/template.md'], { linkCheck: { ignoreTargets: ['NNNN-slug.md'] } }),
    );
    assert.deepEqual(checkLinks(root, cfg, ['adr/template.md']).errors, []);
  });

  it('collects external links for the optional fetch and skips mailto', () => {
    const root = makeRepo({
      'docs/user/a.md': '# A\n\n[x](https://example.com/a) [m](mailto:ops@example.com)\n',
    });
    const { errors, externalLinks } = checkLinks(root, parseSiteConfig(config(['user/a.md'])), [
      'user/a.md',
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalLinks, [{ page: 'docs/user/a.md', url: 'https://example.com/a' }]);
  });

  it('fails a javascript: link', () => {
    const scriptUrl = ['javascript', ':alert(1)'].join('');
    const root = makeRepo({ 'docs/user/a.md': `# A\n\n[x](${scriptUrl})\n` });
    const { errors } = checkLinks(root, parseSiteConfig(config(['user/a.md'])), ['user/a.md']);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /leaves the repository/);
  });

  it('passes the real docs tree of this repository', () => {
    const { problems } = collectProblems(
      REPO_ROOT,
      parseSiteConfig(JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/site.json'), 'utf8'))),
    );
    assert.deepEqual(problems, []);
  });
});

describe('renderMarkdown', () => {
  it('gives every heading an id that matches the link checker, with duplicates suffixed', () => {
    const html = renderMarkdown('# Title\n\n## Usage\n\n## Usage\n', 'a.md');
    assert.match(html, /<h1 id="title">Title<\/h1>/);
    assert.match(html, /<h2 id="usage">Usage<\/h2>/);
    assert.match(html, /<h2 id="usage-1">Usage<\/h2>/);
  });

  it('rewrites a page link to its HTML address and keeps the anchor', () => {
    const html = renderMarkdown('[r](../runbooks/release.md#steps)', 'user/a.md');
    assert.match(html, /href="\.\.\/runbooks\/release\.html#steps"/);
  });

  it('rewrites a repository link to GitHub, and an asset to a relative path', () => {
    const html = renderMarkdown('[c](../../CLAUDE.md) [o](../api/openapi.json)', 'user/a.md');
    assert.match(
      html,
      /href="https:\/\/github\.com\/TinycrowsLab\/Blacwing_SAAS\/blob\/main\/CLAUDE\.md"/,
    );
    assert.match(html, /href="\.\.\/api\/openapi\.json"/);
  });

  it('renders a callout for a GitHub alert and for a bold kind label', () => {
    const html = renderMarkdown('> [!WARNING]\n> Stop first.\n\n> **Note**: read this.\n', 'a.md');
    assert.match(
      html,
      /<aside class="callout callout-warning"[^>]*><p class="callout-title">Warning<\/p>/,
    );
    assert.match(html, /<p>Stop first\.<\/p>/);
    assert.match(html, /<aside class="callout callout-note"/);
    assert.doesNotMatch(html, /\[!WARNING\]/);
  });

  it('keeps an ordinary blockquote as a blockquote', () => {
    const html = renderMarkdown('> just a quote\n', 'a.md');
    assert.match(html, /<blockquote>/);
    assert.doesNotMatch(html, /callout/);
  });

  it('lazy-loads images and keeps link text escaped', () => {
    const html = renderMarkdown('![Diagram](../architecture/blackwing-architecture.html)', 'a.md');
    assert.match(html, /loading="lazy"/);
    assert.match(html, /alt="Diagram"/);
  });

  it('escapes attribute values so a link title cannot break out of the tag', () => {
    const html = renderMarkdown('[x](https://example.com "a\\" onmouseover=\\"alert(1)")', 'a.md');
    // The embedded quotes are entity-escaped, so the attribute cannot close early.
    assert.match(html, /title="a&quot; onmouseover=&quot;alert\(1\)"/);
    assert.doesNotMatch(html, /<a [^>]*" onmouseover="/);
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters and quotes', () => {
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;'");
  });
});

describe('checkExternalLinks', () => {
  const links = [
    { page: 'docs/a.md', url: 'https://ok.example/' },
    { page: 'docs/a.md', url: 'https://gone.example/' },
    { page: 'docs/a.md', url: 'https://down.example/' },
  ];

  it('warns on a non-success answer or a network error, and never throws', async () => {
    const fetchImpl = (/** @type {string | URL | Request} */ input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('gone')) return Promise.resolve(new Response(null, { status: 404 }));
      if (url.includes('down')) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const warnings = await checkExternalLinks(links, fetchImpl);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? '', /answered HTTP 404/);
    assert.match(warnings[1] ?? '', /could not be fetched \(fetch failed\)/);
  });

  it('uses HEAD requests with a timeout signal', async () => {
    /** @type {RequestInit[]} */
    const calls = [];
    await checkExternalLinks([{ page: 'docs/a.md', url: 'https://ok.example/' }], (url, init) => {
      calls.push(init ?? {});
      assert.equal(url, 'https://ok.example/');
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const call = /** @type {RequestInit} */ (calls[0]);
    assert.equal(call.method, 'HEAD');
    assert.ok(call.signal instanceof AbortSignal);
  });
});

describe('buildSite', () => {
  const pages = {
    'docs/site.json': JSON.stringify(config(['user/a.md', 'api/README.md'])),
    'docs/user/a.md':
      '# Start here\n\nSee [the API](../api/README.md#api-reference) and [CLAUDE](../../CLAUDE.md).\n',
    'docs/api/README.md': '# API reference\n\n![spec](openapi.json)\n',
    'docs/api/openapi.json': '{"openapi":"3.1.0"}\n',
    'CLAUDE.md': '# CLAUDE\n',
  };

  it('writes one HTML page per Markdown page, the landing page and copies assets', () => {
    const root = makeRepo(pages);
    const out = path.join(root, 'site');
    const result = buildSite({ root, outDir: out, version: '1.2.0' });
    assert.equal(result.pages, 2);
    assert.equal(result.assets, 1);
    assert.ok(existsSync(path.join(out, '1.2.0', 'user', 'a.html')));
    assert.ok(existsSync(path.join(out, '1.2.0', 'api', 'README.html')));
    assert.ok(existsSync(path.join(out, '1.2.0', 'api', 'openapi.json')));
    assert.ok(existsSync(path.join(out, '1.2.0', 'index.html')));
    assert.ok(!existsSync(path.join(out, '1.2.0', 'site.json')));
    const landing = readFileSync(path.join(out, '1.2.0', 'index.html'), 'utf8');
    assert.match(landing, /href="\.\/user\/a\.html"/);
    assert.match(landing, /English only/);
    const page = readFileSync(path.join(out, '1.2.0', 'user', 'a.html'), 'utf8');
    assert.match(page, /href="\.\.\/api\/README\.html#api-reference"/);
    assert.match(page, /aria-current="page"/);
  });

  it('writes versions.json and an index that list the built versions, with main first', () => {
    const root = makeRepo(pages);
    const out = path.join(root, 'site');
    buildSite({ root, outDir: out, version: '1.2.0' });
    buildSite({ root, outDir: out, version: DEFAULT_VERSION });
    buildSite({ root, outDir: out, version: '1.10.0' });
    const raw = /** @type {unknown} */ (
      JSON.parse(readFileSync(path.join(out, 'versions.json'), 'utf8'))
    );
    const versions = /** @type {{ versions: string[] }} */ (raw);
    assert.deepEqual(versions.versions, [DEFAULT_VERSION, '1.10.0', '1.2.0']);
    assert.match(readFileSync(path.join(out, 'index.html'), 'utf8'), /href="\.\/1\.2\.0\/"/);
  });

  it('fails the build on a broken internal link and writes nothing', () => {
    const root = makeRepo({
      ...pages,
      'docs/user/a.md': '# Start\n\n[gone](../api/missing.md)\n',
    });
    const out = path.join(root, 'site');
    assert.throws(() => buildSite({ root, outDir: out, version: '1.0.0' }), /broken link/);
    assert.ok(!existsSync(path.join(out, '1.0.0')));
  });

  it('fails the build when a page is not in the navigation', () => {
    const root = makeRepo({ ...pages, 'docs/user/extra.md': '# Extra\n' });
    assert.throws(
      () => buildSite({ root, outDir: path.join(root, 'site'), version: '1.0.0' }),
      /not in the site navigation/,
    );
  });

  it('rejects a version name that could escape the output directory', () => {
    const root = makeRepo(pages);
    for (const version of ['../evil', '', '.hidden', 'a/b', 'x'.repeat(65)]) {
      assert.throws(
        () => buildSite({ root, outDir: path.join(root, 'site'), version }),
        /must match/,
        version,
      );
    }
    assert.ok(!existsSync(path.join(root, 'evil')));
  });

  it('keeps the version list in sync when a version folder has no index', () => {
    const root = makeRepo(pages);
    const out = path.join(root, 'site');
    buildSite({ root, outDir: out, version: '2.0.0' });
    mkdirSync(path.join(out, '3.0.0'));
    assert.deepEqual(writeVersionIndex(out, 'Test docs'), ['2.0.0']);
  });
});

describe('parseArgs', () => {
  it('parses build and check flags', () => {
    const args = parseArgs(['build', '--out', 'dist/docs', '--version', '1.0.0']);
    assert.equal(args.command, 'build');
    assert.equal(args.version, '1.0.0');
    assert.match(args.outDir, /dist[\\/]docs$/);
    assert.equal(parseArgs(['check', '--external']).external, true);
  });

  it('rejects an unknown command, an unknown flag and a flag without a value', () => {
    assert.throws(() => parseArgs(['serve']), /usage/);
    assert.throws(() => parseArgs(['check', '--nope']), /unknown argument/);
    assert.throws(() => parseArgs(['build', '--out']), /needs a value/);
    assert.throws(() => parseArgs(['build', '--out', '--version']), /needs a value/);
  });

  it('requires --out for build', () => {
    assert.throws(() => parseArgs(['build']), /needs --out/);
  });
});
