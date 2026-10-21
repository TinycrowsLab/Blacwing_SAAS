#!/usr/bin/env node
// Static documentation site for docs/ (DOCS-001, #813).
//
// The site is generated from the Markdown under docs/ with marked. docs/site.json owns the
// navigation (User Guide, Admin Guide, API Reference, Runbooks, Architecture and Security). Every
// Markdown page must appear in that navigation, and every internal link must resolve: a broken
// internal link, a missing anchor or a navigation entry without a file fails the build.
//
// External links are not fetched by default (CI must not depend on the network). `check --external`
// fetches them and reports failures as warnings only.
//
// Usage:
//   node scripts/docs-site.mjs check [--external] [--root <dir>]
//   node scripts/docs-site.mjs build --out <dir> [--version <name>] [--root <dir>]
// `build` writes <out>/<version>/ plus <out>/index.html and <out>/versions.json (the version list).
// Exits 1 on a failed check and 2 on a usage error.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Marked } from 'marked';

import { extractLinks, headingAnchors, slugify } from './check-claude-md.mjs';

export const DOCS_DIR = 'docs';
export const SITE_CONFIG = 'docs/site.json';
export const REPO_URL = 'https://github.com/TinycrowsLab/Blacwing_SAAS';
export const DEFAULT_VERSION = 'main';
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTERNAL_TIMEOUT_MS = 5000;
const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'];

/**
 * @typedef {{ title: string, sections: Array<{ title: string, pages: string[] }>, ignoreTargets: Set<string> }} SiteConfig
 */

/**
 * Validates docs/site.json (fails closed on any shape problem).
 * @param {unknown} raw
 * @returns {SiteConfig}
 */
export function parseSiteConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${SITE_CONFIG}: must be a JSON object`);
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const errors = [];
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    errors.push('title must be a non-empty string');
  }
  /** @type {SiteConfig['sections']} */
  const sections = [];
  if (!Array.isArray(record.sections) || record.sections.length === 0) {
    errors.push('sections must be a non-empty array');
  } else {
    for (const [index, entry] of /** @type {unknown[]} */ (record.sections).entries()) {
      const section = /** @type {Record<string, unknown>} */ (
        typeof entry === 'object' && entry !== null ? entry : {}
      );
      if (typeof section.title !== 'string' || section.title.trim() === '') {
        errors.push(`sections[${index}].title must be a non-empty string`);
        continue;
      }
      if (!Array.isArray(section.pages) || section.pages.length === 0) {
        errors.push(`sections[${index}] (${section.title}).pages must be a non-empty array`);
        continue;
      }
      /** @type {string[]} */
      const pages = [];
      for (const page of section.pages) {
        if (typeof page !== 'string' || !page.endsWith('.md') || page.startsWith('/')) {
          errors.push(`sections[${index}] (${section.title}): page must be a relative .md path`);
        } else if (page.split('/').includes('..')) {
          errors.push(`sections[${index}] (${section.title}): page ${page} escapes docs/`);
        } else {
          pages.push(page);
        }
      }
      sections.push({ title: section.title, pages });
    }
  }
  /** @type {Set<string>} */
  const ignoreTargets = new Set();
  const linkCheck = record.linkCheck;
  if (linkCheck !== undefined) {
    const ignored =
      typeof linkCheck === 'object' && linkCheck !== null && 'ignoreTargets' in linkCheck
        ? linkCheck.ignoreTargets
        : undefined;
    if (!Array.isArray(ignored) || ignored.some((item) => typeof item !== 'string')) {
      errors.push('linkCheck.ignoreTargets must be an array of strings');
    } else {
      for (const item of /** @type {string[]} */ (ignored)) ignoreTargets.add(item);
    }
  }
  if (errors.length > 0) {
    throw new Error(`${SITE_CONFIG}: ${errors.join('; ')}`);
  }
  return { title: /** @type {string} */ (record.title), sections, ignoreTargets };
}

/**
 * Every Markdown file under docs/, as docs-relative POSIX paths, sorted.
 * @param {string} root repository root
 * @returns {string[]}
 */
export function listDocPages(root) {
  return listFiles(path.join(root, DOCS_DIR))
    .filter((file) => file.endsWith('.md'))
    .sort();
}

/**
 * Every file under a directory, relative to it, as POSIX paths.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listFiles(dir, prefix = '') {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Navigation problems: nav entries without a file, and docs pages the nav does not list.
 * @param {SiteConfig} config
 * @param {string[]} pages docs-relative Markdown pages
 * @returns {string[]}
 */
export function checkNavigation(config, pages) {
  const errors = [];
  const listed = new Set();
  for (const section of config.sections) {
    for (const page of section.pages) {
      listed.add(page);
      if (!pages.includes(page)) {
        errors.push(`${SITE_CONFIG}: "${section.title}" lists ${page}, which does not exist`);
      }
    }
  }
  for (const page of pages) {
    if (!listed.has(page)) {
      errors.push(`${DOCS_DIR}/${page}: not in the site navigation (add it to ${SITE_CONFIG})`);
    }
  }
  return errors;
}

/**
 * Resolves a link written in a docs page.
 * - external (http, https, mailto): `external` with the URL; any other scheme is `invalid`;
 * - same-page anchor: `anchor` with the page;
 * - Markdown page under docs/: `page` with its repo path and anchor;
 * - anything else in the repository (or an asset under docs/): `repo` with its repo path.
 * Absolute `/path` links are repository-root relative, as on GitHub.
 * @param {string} href the raw link target
 * @param {string} pagePath the page's docs-relative path (e.g. `adr/README.md`)
 * @returns {{ kind: 'external', url: string } | { kind: 'anchor', anchor: string } | { kind: 'page' | 'repo', target: string, anchor: string } | { kind: 'invalid' }}
 */
export function resolveHref(href, pagePath) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    // Only web and mail links: javascript:, data: and other schemes fail closed.
    return ['http', 'https', 'mailto'].includes(scheme)
      ? { kind: 'external', url: href }
      : { kind: 'invalid' };
  }
  const hash = href.indexOf('#');
  const rawPath = hash >= 0 ? href.slice(0, hash) : href;
  const anchor = hash >= 0 ? href.slice(hash + 1) : '';
  if (rawPath === '') return { kind: 'anchor', anchor };
  const pageRepoPath = `${DOCS_DIR}/${pagePath}`;
  const target = rawPath.startsWith('/')
    ? path.posix.normalize(rawPath.slice(1))
    : path.posix.join(path.posix.dirname(pageRepoPath), rawPath);
  if (target === '..' || target.startsWith('../')) return { kind: 'invalid' };
  if (target.startsWith(`${DOCS_DIR}/`) && target.endsWith('.md')) {
    return { kind: 'page', target, anchor };
  }
  return { kind: 'repo', target, anchor };
}

/**
 * Checks every internal link in the docs pages. Returns problems as messages.
 * @param {string} root
 * @param {SiteConfig} config
 * @param {string[]} pages
 * @returns {{ errors: string[], externalLinks: Array<{ page: string, url: string }> }}
 */
export function checkLinks(root, config, pages) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Array<{ page: string, url: string }>} */
  const externalLinks = [];
  for (const pagePath of pages) {
    const pageRepo = `${DOCS_DIR}/${pagePath}`;
    const markdown = readFileSync(path.join(root, pageRepo), 'utf8');
    for (const href of extractLinks(markdown)) {
      if (config.ignoreTargets.has(href)) continue;
      const resolved = resolveHref(href, pagePath);
      if (resolved.kind === 'external') {
        if (!resolved.url.startsWith('mailto:')) {
          externalLinks.push({ page: pageRepo, url: resolved.url });
        }
        continue;
      }
      if (resolved.kind === 'invalid') {
        errors.push(`${pageRepo}: link "${href}" leaves the repository`);
        continue;
      }
      if (resolved.kind === 'anchor') {
        if (!headingAnchors(markdown).has(resolved.anchor)) {
          errors.push(`${pageRepo}: link "${href}" has no matching heading`);
        }
        continue;
      }
      const targetAbs = path.join(root, resolved.target);
      if (!existsSync(targetAbs)) {
        errors.push(`${pageRepo}: broken link "${href}" (${resolved.target} does not exist)`);
        continue;
      }
      if (resolved.anchor !== '' && resolved.target.endsWith('.md')) {
        const anchors = headingAnchors(readFileSync(targetAbs, 'utf8'));
        if (!anchors.has(resolved.anchor)) {
          errors.push(`${pageRepo}: link "${href}" has no matching heading in ${resolved.target}`);
        }
      }
    }
  }
  return { errors, externalLinks };
}

/**
 * Fetches external links and reports failures. Warnings only: link rot must not fail the build.
 * @param {Array<{ page: string, url: string }>} links
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string[]>}
 */
export async function checkExternalLinks(links, fetchImpl = fetch) {
  /** @type {string[]} */
  const warnings = [];
  for (const { page, url } of links) {
    try {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      });
      if (!response.ok) warnings.push(`${page}: ${url} answered HTTP ${response.status}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${page}: ${url} could not be fetched (${reason})`);
    }
  }
  return warnings;
}

/**
 * Relative href from one docs page to a target path (both docs-relative).
 * @param {string} fromPage docs-relative page path
 * @param {string} toPath docs-relative target path
 * @returns {string}
 */
function relativeHref(fromPage, toPath) {
  const rel = path.posix.relative(path.posix.dirname(fromPage), toPath);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders one Markdown page to an HTML fragment. Heading ids use the same slug rules as the link
 * checker, so every anchor the checker accepts is present in the output.
 * @param {string} markdown
 * @param {string} pagePath docs-relative path of the page
 * @returns {string}
 */
export function renderMarkdown(markdown, pagePath) {
  /** @type {Map<string, number>} */
  const headingCounts = new Map();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        const base = slugify(text);
        const seen = headingCounts.get(base) ?? 0;
        headingCounts.set(base, seen + 1);
        const id = seen === 0 ? base : `${base}-${seen}`;
        return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const body = this.parser.parseInline(tokens);
        const resolved = resolveHref(href, pagePath);
        let url = href;
        if (resolved.kind === 'anchor') url = `#${resolved.anchor}`;
        if (resolved.kind === 'page') {
          const html = relativeHref(pagePath, resolved.target.slice(DOCS_DIR.length + 1)).replace(
            /\.md$/,
            '.html',
          );
          url = resolved.anchor === '' ? html : `${html}#${resolved.anchor}`;
        }
        if (resolved.kind === 'repo' && resolved.target.startsWith(`${DOCS_DIR}/`)) {
          // Assets under docs/ are copied to the site at the same relative path.
          const asset = relativeHref(pagePath, resolved.target.slice(DOCS_DIR.length + 1));
          url = resolved.anchor === '' ? asset : `${asset}#${resolved.anchor}`;
        } else if (resolved.kind === 'repo') {
          url = repoUrl(resolved.target, resolved.anchor);
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(url)}"${titleAttr}>${body}</a>`;
      },
      image({ href, title, text }) {
        const resolved = resolveHref(href, pagePath);
        let src = href;
        if (resolved.kind === 'repo' && resolved.target.startsWith(`${DOCS_DIR}/`)) {
          src = relativeHref(pagePath, resolved.target.slice(DOCS_DIR.length + 1));
        } else if (resolved.kind === 'repo') {
          src = `${REPO_URL}/raw/main/${resolved.target}`;
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy" decoding="async">`;
      },
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        const match = new RegExp(
          `^<p>(?:\\[!(${CALLOUT_KINDS.join('|')})\\]|<strong>(${CALLOUT_KINDS.join('|')})</strong>)[:\\s]*`,
          'i',
        ).exec(body);
        if (match === null) return `<blockquote>\n${body}</blockquote>\n`;
        const kind = (match[1] ?? match[2] ?? '').toLowerCase();
        const rest = `<p>${body.slice(match[0].length)}`;
        const label = kind.charAt(0).toUpperCase() + kind.slice(1);
        return `<aside class="callout callout-${kind}" role="note"><p class="callout-title">${label}</p>\n${rest}</aside>\n`;
      },
    },
  });
  return marked.parse(markdown, { async: false });
}

/**
 * GitHub blob URL for a repository file (GitHub redirects directories to the tree view).
 * @param {string} target repo path
 * @param {string} anchor
 * @returns {string}
 */
function repoUrl(target, anchor) {
  const base = `${REPO_URL}/blob/main/${target}`;
  return anchor === '' ? base : `${base}#${anchor}`;
}

/**
 * @param {string} markdown
 * @param {string} fallback returned when the page has no level-1 heading
 * @returns {string} the first level-1 heading text
 */
function pageTitle(markdown, fallback) {
  const match = /^#\s+(.+?)\s*$/m.exec(markdown);
  return match?.[1] ?? fallback;
}

/**
 * Full HTML document for one page or the landing page.
 * @param {{ siteTitle: string, title: string, version: string, nav: string, body: string, rootHref: string }} shell
 * @returns {string}
 */
export function pageShell({ siteTitle, title, version, nav, body, rootHref }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | ${escapeHtml(siteTitle)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
<a class="brand" href="${escapeHtml(rootHref)}">${escapeHtml(siteTitle)}</a>
<span class="version">Version ${escapeHtml(version)}</span>
</header>
<div class="layout">
<nav class="sidebar" aria-label="Documentation">
${nav}</nav>
<main class="content">
${body}</main>
</div>
</body>
</html>
`;
}

const STYLE = `:root{--bg:#FFFFFF;--surface:#FFFFFF;--surface2:#F4F4F5;--border:#E6E7EA;--text:#16171D;--muted:#5A5E69;--primary:#004777;--code:#FAFAFA;--ok-soft:#E8F4EC;--warn-soft:#FCF2E4;--bad-soft:#FBECEA;--info-soft:#F0F1F3;--font:Poppins,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#16171D;--surface:#1E1F26;--surface2:#26282F;--border:#30323A;--text:#ECECEE;--muted:#A0A3AC;--primary:#6CB4E4;--code:#191A20;--ok-soft:#132A1C;--warn-soft:#2E2210;--bad-soft:#351A18;--info-soft:#2A2C33}}
:root[data-theme="dark"]{--bg:#16171D;--surface:#1E1F26;--surface2:#26282F;--border:#30323A;--text:#ECECEE;--muted:#A0A3AC;--primary:#6CB4E4;--code:#191A20;--ok-soft:#132A1C;--warn-soft:#2E2210;--bad-soft:#351A18;--info-soft:#2A2C33}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 var(--font)}
a{color:var(--primary)}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface)}
.brand{font-weight:600;color:var(--text);text-decoration:none}
.version{color:var(--muted);font-size:14px}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:calc(100vh - 53px)}
.sidebar{border-right:1px solid var(--border);padding:16px;background:var(--surface2)}
.sidebar h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:16px 0 6px}
.sidebar h2:first-child{margin-top:0}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar li a{display:block;padding:4px 8px;border-radius:6px;color:var(--text);text-decoration:none;font-size:14px}
.sidebar li a[aria-current="page"]{background:var(--surface);font-weight:600;color:var(--primary)}
.content{padding:24px 32px;max-width:860px;min-width:0;overflow-wrap:anywhere}
h1,h2,h3,h4{line-height:1.25}
h1{font-size:28px;margin-top:0}
h2{font-size:22px;margin-top:32px;padding-bottom:4px;border-bottom:1px solid var(--border)}
h3{font-size:18px;margin-top:24px}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;margin:16px 0}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--surface2)}
code{font-family:var(--mono);font-size:.9em;background:var(--code);padding:1px 4px;border-radius:4px}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:12px;overflow-x:auto}
pre code{background:none;padding:0}
img{max-width:100%;height:auto}
blockquote{margin:16px 0;padding:8px 16px;border-left:4px solid var(--border);color:var(--muted)}
.callout{margin:16px 0;padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--info-soft)}
.callout-title{margin:0 0 4px;font-weight:600}
.callout-warning,.callout-caution{background:var(--warn-soft)}
.callout-important{background:var(--bad-soft)}
.callout-tip,.callout-note{background:var(--ok-soft)}
.index-list{padding-left:20px}
@media (max-width:760px){
.layout{grid-template-columns:1fr}
.sidebar{border-right:0;border-bottom:1px solid var(--border)}
.content{padding:16px}
}`;

/**
 * Navigation and internal-link problems for the whole docs tree.
 * @param {string} root
 * @param {SiteConfig} config
 * @returns {{ pages: string[], problems: string[], externalLinks: Array<{ page: string, url: string }> }}
 */
export function collectProblems(root, config) {
  const pages = listDocPages(root);
  const links = checkLinks(root, config, pages);
  return {
    pages,
    problems: [...checkNavigation(config, pages), ...links.errors],
    externalLinks: links.externalLinks,
  };
}

/**
 * Builds the site for one version. Throws when the navigation or any internal link is broken.
 * @param {{ root: string, outDir: string, version: string }} options
 * @returns {{ pages: number, assets: number, externalLinks: Array<{ page: string, url: string }> }}
 */
export function buildSite({ root, outDir, version }) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`version "${version}" must match ${VERSION_PATTERN.source}`);
  }
  const config = parseSiteConfig(JSON.parse(readFileSync(path.join(root, SITE_CONFIG), 'utf8')));
  const { pages, problems, externalLinks } = collectProblems(root, config);
  if (problems.length > 0) {
    throw new Error(`docs build failed:\n  - ${problems.join('\n  - ')}`);
  }

  const siteDir = path.join(outDir, version);
  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(siteDir, { recursive: true });

  /** @param {string} fromPage */
  const nav = (fromPage) =>
    config.sections
      .map(
        (section) =>
          `<h2>${escapeHtml(section.title)}</h2>\n<ul>\n${section.pages
            .map((page) => {
              const current = page === fromPage ? ' aria-current="page"' : '';
              const href = relativeHref(fromPage, page.replace(/\.md$/, '.html'));
              return `<li><a href="${escapeHtml(href)}"${current}>${escapeHtml(navLabel(root, page))}</a></li>`;
            })
            .join('\n')}\n</ul>\n`,
      )
      .join('');

  for (const page of pages) {
    const markdown = readFileSync(path.join(root, DOCS_DIR, page), 'utf8');
    const html = pageShell({
      siteTitle: config.title,
      title: pageTitle(markdown, page),
      version,
      nav: nav(page),
      body: renderMarkdown(markdown, page),
      rootHref: relativeHref(page, 'index.html'),
    });
    const out = path.join(siteDir, page.replace(/\.md$/, '.html'));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, html);
  }

  const landing = config.sections
    .map(
      (section) =>
        `<h2>${escapeHtml(section.title)}</h2>\n<ul class="index-list">\n${section.pages
          .map((page) => {
            const href = relativeHref('index.md', page.replace(/\.md$/, '.html'));
            return `<li><a href="${escapeHtml(href)}">${escapeHtml(navLabel(root, page))}</a></li>`;
          })
          .join('\n')}\n</ul>\n`,
    )
    .join('');
  writeFileSync(
    path.join(siteDir, 'index.html'),
    pageShell({
      siteTitle: config.title,
      title: 'Home',
      version,
      nav: nav('index.md'),
      body: `<h1>${escapeHtml(config.title)}</h1>\n<p>Documentation for version ${escapeHtml(version)}. English only (v1).</p>\n${landing}`,
      rootHref: './index.html',
    }),
  );

  let assets = 0;
  for (const file of listFiles(path.join(root, DOCS_DIR))) {
    if (file.endsWith('.md') || file === 'site.json') continue;
    const dest = path.join(siteDir, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(root, DOCS_DIR, file), dest);
    assets += 1;
  }
  writeVersionIndex(outDir, config.title);
  return { pages: pages.length, assets, externalLinks };
}

/**
 * Link label for a navigation entry: the page's first heading.
 * @param {string} root
 * @param {string} page
 * @returns {string}
 */
function navLabel(root, page) {
  return pageTitle(readFileSync(path.join(root, DOCS_DIR, page), 'utf8'), page);
}

/**
 * Regenerates <outDir>/index.html and <outDir>/versions.json from the version folders present.
 * `main` sorts first (the unreleased docs); the rest sort newest name first.
 * @param {string} outDir
 * @param {string} siteTitle
 * @returns {string[]} the versions listed
 */
export function writeVersionIndex(outDir, siteTitle) {
  const versions = readdirSync(outDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        VERSION_PATTERN.test(entry.name) &&
        existsSync(path.join(outDir, entry.name, 'index.html')),
    )
    .map((entry) => entry.name)
    .sort((a, b) => {
      if (a === DEFAULT_VERSION) return -1;
      if (b === DEFAULT_VERSION) return 1;
      return b.localeCompare(a, 'en', { numeric: true });
    });
  writeFileSync(path.join(outDir, 'versions.json'), `${JSON.stringify({ versions }, null, 2)}\n`);
  const items = versions
    .map((name) => `<li><a href="./${name}/">${escapeHtml(name)}</a></li>`)
    .join('\n');
  writeFileSync(
    path.join(outDir, 'index.html'),
    pageShell({
      siteTitle,
      title: 'Versions',
      version: versions[0] ?? DEFAULT_VERSION,
      nav: '',
      body: `<h1>${escapeHtml(siteTitle)}</h1>\n<h2>Versions</h2>\n<ul class="index-list">\n${items}\n</ul>\n`,
      rootHref: './index.html',
    }),
  );
  return versions;
}

/**
 * @param {string[]} argv
 * @returns {{ command: string, root: string, outDir: string, version: string, external: boolean }}
 */
export function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  /** @type {{ command: string, root: string, outDir: string, version: string, external: boolean }} */
  const args = {
    command,
    root: process.cwd(),
    outDir: '',
    version: DEFAULT_VERSION,
    external: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--external') {
      args.external = true;
    } else if (flag === '--root' || flag === '--out' || flag === '--version') {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
      }
      if (flag === '--root') args.root = path.resolve(value);
      if (flag === '--out') args.outDir = path.resolve(value);
      if (flag === '--version') args.version = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${flag ?? ''}`);
    }
  }
  if (command !== 'check' && command !== 'build') {
    throw new Error(
      'usage: docs-site.mjs <check|build> [--out <dir>] [--version <name>] [--external] [--root <dir>]',
    );
  }
  if (command === 'build' && args.outDir === '') throw new Error('build needs --out <dir>');
  return args;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`docs-site: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    if (args.command === 'check') {
      const config = parseSiteConfig(
        JSON.parse(readFileSync(path.join(args.root, SITE_CONFIG), 'utf8')),
      );
      const { pages, problems, externalLinks } = collectProblems(args.root, config);
      if (problems.length > 0) {
        process.stderr.write(
          `docs-site: ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}\n`,
        );
        return 1;
      }
      process.stdout.write(
        `docs-site: ${pages.length} pages, ${externalLinks.length} external link(s), no broken internal links\n`,
      );
      if (args.external) {
        const warnings = await checkExternalLinks(externalLinks);
        for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
      }
      return 0;
    }
    const result = buildSite({ root: args.root, outDir: args.outDir, version: args.version });
    process.stdout.write(
      `docs-site: built ${result.pages} pages and ${result.assets} assets into ${path.join(args.outDir, args.version)}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`docs-site: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
