#!/usr/bin/env node
// Guards the root CLAUDE.md against drift from docs/architecture/CONTEXT_PACK.md (FOUND-014).
//
// Detects:
//   - a missing CLAUDE.md or Context Pack;
//   - missing required sections, core pnpm commands, coding rules, DoD rules,
//     branch/commit rules or "never do" items;
//   - missing links to Context Pack §5, §8 and §10, the ADR index and the dependency graph;
//   - broken relative links, and anchors that match no heading in the linked Markdown file
//     (GitHub heading-slug rules);
//   - `§N` references to Context Pack sections that do not exist;
//   - growth past MAX_LINES (CLAUDE.md links to the pack instead of copying it).
//
// External (http/https/mailto) links are not fetched; the docs link-check (DOCS-001) owns them.
//
// Usage: node scripts/check-claude-md.mjs [--root <dir>] [--quiet]
// Prints a structured JSON summary on stdout; exits non-zero when any check fails.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_MD = 'CLAUDE.md';
export const CONTEXT_PACK = 'docs/architecture/CONTEXT_PACK.md';

/** CLAUDE.md must stay concise: it points at the pack rather than duplicating it. */
export const MAX_LINES = 200;

/**
 * Link targets owned by issues that have not landed yet. They may be missing; once the
 * file exists it is checked like any other link (anchors included).
 */
export const PENDING_LINK_TARGETS = Object.freeze({
  'docs/adr/README.md': 'FOUND-015 (#17)',
});

/** Repository-relative files CLAUDE.md must link to. */
export const REQUIRED_LINK_TARGETS = Object.freeze([
  CONTEXT_PACK,
  'docs/adr/README.md',
  'docs/architecture/dependency-graph.md',
]);

/** Context Pack top-level sections CLAUDE.md must link to (stack, invariants, DoD). */
export const REQUIRED_PACK_SECTIONS = Object.freeze(['5', '8', '10']);

/** Level-2 headings CLAUDE.md must contain. */
export const REQUIRED_SECTIONS = Object.freeze([
  'Project overview',
  'Read first',
  'Repository map',
  'Commands',
  'Coding conventions',
  'Security invariants',
  'Definition of Done',
  'Branches, commits and PRs',
  'Never do',
]);

/** Core pnpm commands that must appear (as inline code) in the Commands section. */
export const REQUIRED_COMMANDS = Object.freeze([
  'pnpm dev:deps',
  'pnpm dev',
  'pnpm test',
  'pnpm test:int',
  'pnpm test:e2e',
  'pnpm lint',
  'pnpm typecheck',
]);

/**
 * Required statements per section: [section, description, pattern].
 * @type {ReadonlyArray<readonly [string, string, RegExp]>}
 */
export const REQUIRED_STATEMENTS = Object.freeze([
  [
    'Coding conventions',
    'logging only through @blackwing/logger',
    /logging goes only through `@blackwing\/logger`/i,
  ],
  [
    'Coding conventions',
    'environment only through @blackwing/config',
    /environment goes only through `@blackwing\/config`/i,
  ],
  ['Coding conventions', 'errors via @blackwing/errors', /errors go through `@blackwing\/errors`/i],
  ['Coding conventions', 'strict TypeScript', /strict typescript/i],
  ['Coding conventions', 'no `any`', /no `any`/i],
  ['Coding conventions', 'Zod at boundaries', /zod/i],
  ['Definition of Done', 'no `any`', /no `any`/i],
  ['Definition of Done', 'no skipped tests', /no skipped tests/i],
  ['Definition of Done', 'no TODO without a linked issue', /no TODO without a linked issue/i],
  ['Branches, commits and PRs', 'branch naming', /`<issue-key>-<slug>`/],
  ['Branches, commits and PRs', 'Conventional Commits', /conventional commits/i],
  ['Branches, commits and PRs', 'PR closes its issue', /`Closes #N`/],
  [
    'Never do',
    'never expose the host Docker socket to sandboxes',
    /never expose the host docker socket/i,
  ],
  ['Never do', 'never call the product "Claude Code"', /never call the product "Claude Code"/i],
  ['Never do', 'never add exploit payloads to the repo', /never add exploit payloads/i],
  ['Never do', 'never weaken §8 invariants', /never weaken a §8 invariant/i],
  ['Never do', 'never log secrets', /never log secrets/i],
]);

/**
 * GitHub-style heading slug (github-slugger semantics): lowercase, drop punctuation and
 * symbols, each space becomes a hyphen. Inline code markers are removed, text kept.
 * @param {string} heading
 * @returns {string}
 */
export function slugify(heading) {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Removes fenced code blocks (keeping line count) so their content is not parsed as Markdown.
 * @param {string} markdown
 * @returns {string}
 */
function stripFences(markdown) {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/**
 * @param {string} markdown
 * @returns {Array<{ level: number, text: string }>}
 */
export function parseHeadings(markdown) {
  /** @type {Array<{ level: number, text: string }>} */
  const headings = [];
  for (const line of stripFences(markdown).split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      headings.push({ level: match[1].length, text: match[2] });
    }
  }
  return headings;
}

/**
 * All anchors GitHub generates for a document, with `-1`, `-2` suffixes for duplicates.
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function headingAnchors(markdown) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Set<string>} */
  const anchors = new Set();
  for (const { text } of parseHeadings(markdown)) {
    const base = slugify(text);
    const seen = counts.get(base) ?? 0;
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
    counts.set(base, seen + 1);
  }
  return anchors;
}

/**
 * Maps each numbered heading's anchor to its section number (e.g. "8", "4.5").
 * @param {string} markdown
 * @returns {Map<string, string>}
 */
export function numberedSections(markdown) {
  /** @type {Map<string, string>} */
  const sections = new Map();
  for (const { text } of parseHeadings(markdown)) {
    const match = /^(\d+(?:\.\d+)*)\.?\s/.exec(text);
    if (match?.[1] !== undefined) sections.set(slugify(text), match[1]);
  }
  return sections;
}

/**
 * Inline Markdown link targets outside code (fenced blocks and inline code spans).
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractLinks(markdown) {
  const text = stripFences(markdown).replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  const links = [];
  const pattern = /\[(?:[^\]\n]|\[[^\]\n]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) links.push(match[1]);
  }
  return links;
}

/**
 * Splits a document into its level-2 sections: heading text -> body.
 * @param {string} markdown
 * @returns {Map<string, string>}
 */
export function sectionsByHeading(markdown) {
  /** @type {Map<string, string>} */
  const sections = new Map();
  /** @type {string | undefined} */
  let current;
  /** @type {string[]} */
  let body = [];
  let inFence = false;
  const flush = () => {
    if (current !== undefined) sections.set(current, body.join('\n'));
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      current = match[1];
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * @param {string} file
 * @returns {string | undefined}
 */
function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/**
 * Checks CLAUDE.md under `root`.
 * @param {string} root repository root
 * @param {{ text?: string }} [options] `text` overrides the CLAUDE.md content (tests)
 * @returns {{ ok: boolean, errors: string[], linksChecked: number, packSectionsLinked: string[] }}
 */
export function checkClaudeMd(root, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const result = () => ({
    ok: errors.length === 0,
    errors,
    linksChecked,
    packSectionsLinked: [...packSections].sort(),
  });
  let linksChecked = 0;
  /** @type {Set<string>} */
  const packSections = new Set();

  const text = options.text ?? readIfExists(path.join(root, CLAUDE_MD));
  if (text === undefined) {
    errors.push(`${CLAUDE_MD}: missing at repository root`);
    return result();
  }
  const packText = readIfExists(path.join(root, CONTEXT_PACK));
  if (packText === undefined) {
    errors.push(`${CONTEXT_PACK}: missing (CLAUDE.md links to it)`);
    return result();
  }

  const lineCount = text.split('\n').length;
  if (lineCount > MAX_LINES) {
    errors.push(
      `${CLAUDE_MD}: ${lineCount} lines exceeds ${MAX_LINES}; link to the Context Pack instead of copying it`,
    );
  }

  // Sections and required statements.
  const sections = sectionsByHeading(text);
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) errors.push(`${CLAUDE_MD}: missing section "## ${name}"`);
  }
  const commands = sections.get('Commands');
  if (commands !== undefined) {
    for (const command of REQUIRED_COMMANDS) {
      if (!commands.includes(`\`${command}\``)) {
        errors.push(`${CLAUDE_MD}: "## Commands" does not list \`${command}\``);
      }
    }
  }
  for (const [section, description, pattern] of REQUIRED_STATEMENTS) {
    const body = sections.get(section);
    if (body !== undefined && !pattern.test(body)) {
      errors.push(`${CLAUDE_MD}: "## ${section}" is missing the rule: ${description}`);
    }
  }

  // Links.
  const ownAnchors = headingAnchors(text);
  const packAnchors = headingAnchors(packText);
  const packNumbered = numberedSections(packText);
  /** @type {Map<string, Set<string>>} */
  const anchorCache = new Map([[CONTEXT_PACK, packAnchors]]);
  /** @type {Set<string>} */
  const linkedTargets = new Set();

  for (const link of extractLinks(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // external (http, https, mailto, ...)
    linksChecked += 1;
    const hashAt = link.indexOf('#');
    const rawPath = hashAt === -1 ? link : link.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : decodeURIComponent(link.slice(hashAt + 1));

    if (rawPath.startsWith('/')) {
      errors.push(
        `${CLAUDE_MD}: link "${link}" must be relative to the repository root, not absolute`,
      );
      continue;
    }
    if (rawPath === '') {
      if (!ownAnchors.has(anchor))
        errors.push(`${CLAUDE_MD}: link "${link}" matches no heading in CLAUDE.md`);
      continue;
    }

    const target = path.posix.normalize(decodeURIComponent(rawPath));
    if (target.startsWith('..')) {
      errors.push(`${CLAUDE_MD}: link "${link}" points outside the repository`);
      continue;
    }
    linkedTargets.add(target);
    const absolute = path.join(root, target);
    if (!existsSync(absolute)) {
      if (!Object.hasOwn(PENDING_LINK_TARGETS, target)) {
        errors.push(`${CLAUDE_MD}: broken link "${link}" (${target} does not exist)`);
      }
      continue;
    }
    if (anchor === '') continue;
    if (!target.endsWith('.md')) {
      errors.push(`${CLAUDE_MD}: link "${link}" has an anchor but ${target} is not Markdown`);
      continue;
    }
    let anchors = anchorCache.get(target);
    if (anchors === undefined) {
      anchors = headingAnchors(readFileSync(absolute, 'utf8'));
      anchorCache.set(target, anchors);
    }
    if (!anchors.has(anchor)) {
      errors.push(`${CLAUDE_MD}: link "${link}" matches no heading in ${target}`);
      continue;
    }
    if (target === CONTEXT_PACK) {
      const number = packNumbered.get(anchor);
      if (number !== undefined) packSections.add(number);
    }
  }

  for (const target of REQUIRED_LINK_TARGETS) {
    if (!linkedTargets.has(target)) errors.push(`${CLAUDE_MD}: must link to ${target}`);
  }
  for (const number of REQUIRED_PACK_SECTIONS) {
    if (!packSections.has(number)) {
      errors.push(`${CLAUDE_MD}: must link to ${CONTEXT_PACK} §${number} (heading anchor)`);
    }
  }

  // Every §N / §N.M reference must name a Context Pack section that exists.
  const existing = new Set(packNumbered.values());
  for (const match of stripFences(text).matchAll(/§\s?(\d+(?:\.\d+)*)/g)) {
    const number = match[1];
    if (number !== undefined && !existing.has(number)) {
      errors.push(`${CLAUDE_MD}: references §${number}, which does not exist in ${CONTEXT_PACK}`);
    }
  }

  return result();
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, quiet: boolean }}
 */
function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--root requires a directory argument');
      root = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, quiet };
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `check-claude-md: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const result = checkClaudeMd(args.root);
  if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `check-claude-md: ${result.errors.length} problem(s) found:\n` +
        result.errors.map((e) => `  - ${e}`).join('\n') +
        '\n',
    );
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
