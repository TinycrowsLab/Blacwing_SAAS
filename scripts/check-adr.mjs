#!/usr/bin/env node
// Checks the architecture decision records in docs/adr/ (FOUND-015, ADR-0001).
//
// Detects:
//   - unexpected files, malformed file names, duplicate or non-contiguous numbers (from 0001);
//   - a missing or malformed `# ADR-NNNN: <title>` heading or `Date: YYYY-MM-DD` line;
//   - required sections (Status, Context, Decision, Consequences, References) that are missing,
//     empty or out of order;
//   - unknown status values and one-sided or inconsistent supersession links;
//   - an ADR whose References cite no Context Pack heading;
//   - relative links to missing files or headings, links that leave the repository, and `§N`
//     references to Context Pack sections (or §8-style numbered items) that do not exist;
//   - an index (docs/adr/README.md) that misses an ADR, lists an unknown one, is out of order or
//     disagrees with an ADR's title or status;
//   - Markdown lint failures (see lintMarkdown) and ADRs longer than MAX_ADR_LINES.
//
// External (http/https/mailto) links are not fetched; the docs link check (DOCS-001) owns them.
//
// Usage: node scripts/check-adr.mjs [--root <dir>] [--quiet]
// Prints a structured JSON summary on stdout; exits non-zero when any check fails.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTEXT_PACK,
  extractLinks,
  headingAnchors,
  parseHeadings,
  sectionsByHeading,
  slugify,
} from './check-claude-md.mjs';

export { CONTEXT_PACK };

export const ADR_DIR = 'docs/adr';
export const INDEX_FILE = 'README.md';
export const TEMPLATE_FILE = 'template.md';

/** Files in docs/adr/ that are not ADRs. */
export const NON_ADR_ENTRIES = Object.freeze([INDEX_FILE, TEMPLATE_FILE, '.gitkeep']);

/** `NNNN-kebab-case-title.md`. */
export const ADR_FILE_PATTERN = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** Level-2 sections every ADR (and the template) has, in this order. */
export const REQUIRED_SECTIONS = Object.freeze([
  'Status',
  'Context',
  'Decision',
  'Consequences',
  'References',
]);

/** Plain status values; "Superseded by [ADR-NNNN](…)" is the only other one. */
export const STATUS_VALUES = Object.freeze(['Proposed', 'Accepted', 'Rejected', 'Deprecated']);

/** ADRs restate decisions, not implementation detail: keep each one short. */
export const MAX_ADR_LINES = 120;

/** Width of the zero-padded ADR number. */
const NUMBER_WIDTH = 4;

const SUPERSEDED_BY = /^Superseded by \[ADR-(\d{4})\]\(([^)\s]+)\)$/;
const SUPERSEDES = /^Supersedes \[ADR-(\d{4})\]\(([^)\s]+)\)$/;
const DATE_LINE = /^Date: (\d{4})-(\d{2})-(\d{2})$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * @typedef {object} Adr
 * @property {string} file          file name inside docs/adr/
 * @property {string} number        zero-padded number, e.g. "0008"
 * @property {string} title         title after "ADR-NNNN: "
 * @property {string} status        normalised status ("Accepted", "Superseded by ADR-0012", ...)
 * @property {string | undefined} supersededBy  number of the superseding ADR
 * @property {string[]} supersedes  numbers this ADR supersedes
 * @property {string[]} cites       Context Pack anchors linked from the References section
 */

/**
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  return String(value).padStart(NUMBER_WIDTH, '0');
}

/**
 * Replaces Markdown links by their label: "Superseded by [ADR-0012](x.md)" -> "Superseded by ADR-0012".
 * @param {string} text
 * @returns {string}
 */
export function stripLinks(text) {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Every Context Pack section number that exists: numbered headings ("4.5") plus the items of
 * a top-level ordered list directly under a numbered heading ("8.2" is item 2 of §8).
 * @param {string} packText
 * @returns {Set<string>}
 */
export function packSectionNumbers(packText) {
  /** @type {Set<string>} */
  const numbers = new Set();
  /** @type {string | undefined} */
  let current;
  let inFence = false;
  for (const line of packText.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      const numbered = /^(\d+(?:\.\d+)*)\.?\s/.exec(heading[1]);
      current = numbered?.[1];
      if (current !== undefined) numbers.add(current);
      continue;
    }
    const item = /^(\d+)\.\s/.exec(line);
    if (item?.[1] !== undefined && current !== undefined) numbers.add(`${current}.${item[1]}`);
  }
  return numbers;
}

/**
 * Maps every Context Pack heading anchor to the number of its section: a numbered heading maps
 * to its own number, an unnumbered one to the nearest numbered heading above it ("Definition of
 * Done" -> "10"). Duplicate headings get the `-1`, `-2` anchor suffixes.
 * @param {string} packText
 * @returns {Map<string, string>}
 */
export function packAnchorSections(packText) {
  /** @type {Map<string, string>} */
  const sections = new Map();
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {string | undefined} */
  let current;
  for (const { text } of parseHeadings(packText)) {
    const base = slugify(text);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    const numbered = /^(\d+(?:\.\d+)*)\.?\s/.exec(text);
    if (numbered?.[1] !== undefined) current = numbered[1];
    if (current !== undefined) sections.set(seen === 0 ? base : `${base}-${seen}`, current);
  }
  return sections;
}

/**
 * Sorts and de-duplicates section numbers numerically ("4.5" < "10").
 * @param {Iterable<string>} numbers
 * @returns {string[]}
 */
export function sortSections(numbers) {
  return [...new Set(numbers)].sort((a, b) => {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const diff = (left[i] ?? -1) - (right[i] ?? -1);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

/**
 * @param {Iterable<string>} numbers
 * @returns {string}  e.g. "§4.5, §10"
 */
function formatSections(numbers) {
  return sortSections(numbers)
    .map((n) => `§${n}`)
    .join(', ');
}

/**
 * `§N` / `§N.M` references outside fenced code.
 * @param {string} text
 * @returns {string[]}
 */
export function sectionReferences(text) {
  const refs = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const match of line.matchAll(/§\s?(\d+(?:\.\d+)*)/g)) {
      if (match[1] !== undefined) refs.push(match[1]);
    }
  }
  return refs;
}

/**
 * A small Markdown lint for the ADR directory (markdownlint rules in brackets):
 * LF line endings, one final newline [MD047], no trailing whitespace [MD009], no hard tabs
 * [MD010], no consecutive blank lines [MD012], a space after the heading marker [MD018], the
 * first line is the only H1 [MD041, MD025], heading levels step by one [MD001], blank lines
 * around headings [MD022] and closed code fences.
 * @param {string} text
 * @param {string} label  file name used in messages
 * @returns {string[]}
 */
export function lintMarkdown(text, label) {
  /** @type {string[]} */
  const errors = [];
  if (text.includes('\r')) errors.push(`${label}: uses CRLF line endings; use LF`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) {
    errors.push(`${label}: must end with exactly one newline`);
  }
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
  let inFence = false;
  let fenceLine = 0;
  let h1Count = 0;
  let previousLevel = 0;
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const where = `${label}:${lineNo}`;
    if (/[ \t]+$/.test(line)) errors.push(`${where}: trailing whitespace`);
    if (line.includes('\t')) errors.push(`${where}: hard tab`);
    if (FENCE.test(line)) {
      inFence = !inFence;
      fenceLine = lineNo;
      continue;
    }
    if (inFence) continue;
    if (line === '' && index > 0 && lines[index - 1] === '') {
      errors.push(`${where}: multiple consecutive blank lines`);
    }
    if (/^#{1,6}[^#\s]/.test(line)) errors.push(`${where}: no space after heading marker`);
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading?.[1] === undefined) {
      if (index === 0) errors.push(`${where}: first line must be a level-1 heading`);
      continue;
    }
    const level = heading[1].length;
    if (level === 1) {
      h1Count += 1;
      if (index !== 0) errors.push(`${where}: level-1 heading must be the first line`);
    } else if (index === 0) {
      errors.push(`${where}: first line must be a level-1 heading`);
    }
    if (level > previousLevel + 1) {
      errors.push(`${where}: heading jumps from level ${previousLevel} to ${level}`);
    }
    previousLevel = level;
    if (index > 0 && lines[index - 1] !== '') {
      errors.push(`${where}: heading needs a blank line before it`);
    }
    const next = lines[index + 1];
    if (next !== undefined && next !== '') {
      errors.push(`${where}: heading needs a blank line after it`);
    }
  }
  if (inFence) errors.push(`${label}:${fenceLine}: code fence is never closed`);
  if (h1Count > 1) errors.push(`${label}: has ${h1Count} level-1 headings; use exactly one`);
  return errors;
}

/**
 * Checks the order and presence of the required level-2 sections.
 * @param {string} text
 * @param {string} label
 * @returns {{ errors: string[], sections: Map<string, string> }}
 */
function checkSections(text, label) {
  /** @type {string[]} */
  const errors = [];
  const sections = sectionsByHeading(text);
  const order = parseHeadings(text)
    .filter((h) => h.level === 2)
    .map((h) => h.text);
  let cursor = -1;
  for (const name of REQUIRED_SECTIONS) {
    const at = order.indexOf(name);
    if (at === -1) {
      errors.push(`${label}: missing section "## ${name}"`);
      continue;
    }
    if (at < cursor) errors.push(`${label}: section "## ${name}" is out of order`);
    cursor = Math.max(cursor, at);
    if (stripComments(sections.get(name) ?? '').trim() === '') {
      errors.push(`${label}: section "## ${name}" is empty`);
    }
  }
  return { errors, sections };
}

/**
 * @param {string} year
 * @param {string} month
 * @param {string} day
 * @returns {boolean}
 */
function isCalendarDate(year, month, day) {
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso);
}

/**
 * Validates the relative links of a docs/adr/ Markdown file.
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.label
 * @param {string} args.text
 * @param {Map<string, Set<string>>} args.anchorCache  repository-relative path -> anchors
 * @returns {{ errors: string[], packAnchors: string[], targets: string[] }}
 */
function checkLinks({ root, label, text, anchorCache }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const packAnchors = [];
  /** @type {string[]} */
  const targets = [];
  for (const link of extractLinks(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // external (http, https, mailto, ...)
    const hashAt = link.indexOf('#');
    const rawPath = hashAt === -1 ? link : link.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : decodeURIComponent(link.slice(hashAt + 1));
    if (rawPath.startsWith('/')) {
      errors.push(`${label}: link "${link}" must be relative, not absolute`);
      continue;
    }
    const target =
      rawPath === ''
        ? `${ADR_DIR}/${label}`
        : path.posix.normalize(path.posix.join(ADR_DIR, decodeURIComponent(rawPath)));
    if (target.startsWith('..')) {
      errors.push(`${label}: link "${link}" points outside the repository`);
      continue;
    }
    const absolute = path.join(root, target);
    if (!existsSync(absolute)) {
      errors.push(`${label}: broken link "${link}" (${target} does not exist)`);
      continue;
    }
    targets.push(target);
    if (anchor === '') continue;
    if (!target.endsWith('.md')) {
      errors.push(`${label}: link "${link}" has an anchor but ${target} is not Markdown`);
      continue;
    }
    let anchors = anchorCache.get(target);
    if (anchors === undefined) {
      anchors = headingAnchors(readFileSync(absolute, 'utf8'));
      anchorCache.set(target, anchors);
    }
    if (!anchors.has(anchor)) {
      errors.push(`${label}: link "${link}" matches no heading in ${target}`);
      continue;
    }
    if (target === CONTEXT_PACK) packAnchors.push(anchor);
  }
  return { errors, packAnchors, targets };
}

/**
 * Parses and checks one ADR file.
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.file
 * @param {string} args.number
 * @param {Set<string>} args.packNumbers
 * @param {Map<string, Set<string>>} args.anchorCache
 * @returns {{ errors: string[], adr: Adr }}
 */
function checkAdrFile({ root, file, number, packNumbers, anchorCache }) {
  const text = readFileSync(path.join(root, ADR_DIR, file), 'utf8');
  const errors = lintMarkdown(text, file);
  /** @type {Adr} */
  const adr = {
    file,
    number,
    title: '',
    status: '',
    supersededBy: undefined,
    supersedes: [],
    cites: [],
  };

  const lineCount = text.replace(/\n$/, '').split('\n').length;
  if (lineCount > MAX_ADR_LINES) {
    errors.push(
      `${file}: ${lineCount} lines exceeds ${MAX_ADR_LINES}; restate the decision, not implementation detail`,
    );
  }

  const h1 = parseHeadings(text).find((h) => h.level === 1);
  const titleMatch = h1 === undefined ? null : /^ADR-(\d{4}): (\S.*)$/.exec(h1.text);
  if (titleMatch?.[1] === undefined || titleMatch[2] === undefined) {
    errors.push(`${file}: title must be "# ADR-${number}: <decision>"`);
  } else {
    if (titleMatch[1] !== number) {
      errors.push(`${file}: title says ADR-${titleMatch[1]} but the file is number ${number}`);
    }
    adr.title = titleMatch[2];
    if (adr.title.endsWith('.')) errors.push(`${file}: title must not end with a period`);
  }

  const preamble = text.split(/^## /m)[0] ?? '';
  const dateLine = preamble.split('\n').find((line) => line.startsWith('Date:'));
  const date = dateLine === undefined ? null : DATE_LINE.exec(dateLine);
  if (date?.[1] === undefined || date[2] === undefined || date[3] === undefined) {
    errors.push(`${file}: needs a "Date: YYYY-MM-DD" line before the first section`);
  } else if (!isCalendarDate(date[1], date[2], date[3])) {
    errors.push(`${file}: "${dateLine ?? ''}" is not a valid calendar date`);
  }

  const { errors: sectionErrors, sections } = checkSections(text, file);
  errors.push(...sectionErrors);

  const statusLines = stripComments(sections.get('Status') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [first, ...rest] = statusLines;
  if (first !== undefined) {
    const superseded = SUPERSEDED_BY.exec(first);
    if (STATUS_VALUES.includes(first)) {
      adr.status = first;
    } else if (superseded?.[1] !== undefined && superseded[2] !== undefined) {
      adr.supersededBy = superseded[1];
      adr.status = `Superseded by ADR-${superseded[1]}`;
      if (!superseded[2].startsWith(`${superseded[1]}-`)) {
        errors.push(
          `${file}: "${first}" links to ${superseded[2]}, not an ADR-${superseded[1]} file`,
        );
      }
    } else {
      errors.push(
        `${file}: unknown status "${first}" (use ${STATUS_VALUES.join(', ')} or "Superseded by [ADR-NNNN](NNNN-….md)")`,
      );
    }
  }
  for (const line of rest) {
    const supersedes = SUPERSEDES.exec(line);
    if (supersedes?.[1] === undefined || supersedes[2] === undefined) {
      errors.push(`${file}: unexpected Status line "${line}" (only "Supersedes [ADR-NNNN](…)")`);
      continue;
    }
    adr.supersedes.push(supersedes[1]);
    if (!supersedes[2].startsWith(`${supersedes[1]}-`)) {
      errors.push(`${file}: "${line}" links to ${supersedes[2]}, not an ADR-${supersedes[1]} file`);
    }
  }

  const links = checkLinks({ root, label: file, text, anchorCache });
  errors.push(...links.errors);
  const references = sections.get('References');
  if (references !== undefined) {
    adr.cites = checkLinks({ root, label: file, text: references, anchorCache }).packAnchors;
    if (adr.cites.length === 0) {
      errors.push(
        `${file}: "## References" must cite a ${CONTEXT_PACK} heading (link with an #anchor)`,
      );
    }
  }

  for (const ref of sectionReferences(text)) {
    if (!packNumbers.has(ref)) {
      errors.push(`${file}: references §${ref}, which does not exist in ${CONTEXT_PACK}`);
    }
  }
  return { errors, adr };
}

/**
 * Cross-checks supersession links in both directions.
 * @param {Map<string, Adr>} byNumber
 * @returns {string[]}
 */
function checkSupersession(byNumber) {
  /** @type {string[]} */
  const errors = [];
  for (const adr of byNumber.values()) {
    if (adr.supersededBy !== undefined) {
      const successor = byNumber.get(adr.supersededBy);
      if (successor === undefined) {
        errors.push(`${adr.file}: superseded by ADR-${adr.supersededBy}, which does not exist`);
      } else if (Number(adr.supersededBy) <= Number(adr.number)) {
        errors.push(
          `${adr.file}: superseded by ADR-${adr.supersededBy}; a superseding ADR must be newer`,
        );
      } else if (!successor.supersedes.includes(adr.number)) {
        errors.push(
          `${adr.file}: superseded by ADR-${adr.supersededBy}, but ${successor.file} does not say "Supersedes [ADR-${adr.number}](…)"`,
        );
      }
    }
    for (const old of adr.supersedes) {
      const predecessor = byNumber.get(old);
      if (predecessor === undefined) {
        errors.push(`${adr.file}: supersedes ADR-${old}, which does not exist`);
      } else if (predecessor.supersededBy !== adr.number) {
        errors.push(
          `${adr.file}: supersedes ADR-${old}, but ${predecessor.file} is not "Superseded by [ADR-${adr.number}](…)"`,
        );
      }
    }
  }
  return errors;
}

/**
 * Checks that the index table lists every ADR, in order, with matching title, status and cited
 * Context Pack sections.
 * @param {object} args
 * @param {string} args.text
 * @param {Adr[]} args.adrs  sorted by number
 * @param {Map<string, string>} args.anchorSections  Context Pack anchor -> section number
 * @returns {string[]}
 */
export function checkIndex({ text, adrs, anchorSections }) {
  /** @type {string[]} */
  const errors = [];
  const label = INDEX_FILE;
  const section = sectionsByHeading(text).get('Index');
  if (section === undefined) return [`${label}: missing section "## Index"`];
  const rows = section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .slice(2); // header + separator
  /** @type {string[]} */
  const listed = [];
  for (const row of rows) {
    const cells = row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    const [linkCell = '', titleCell = '', statusCell = '', packCell = ''] = cells;
    const link = /^\[(\d{4})\]\(([^)\s]+)\)$/.exec(linkCell);
    if (link?.[1] === undefined || link[2] === undefined) {
      errors.push(`${label}: index row "${row.trim()}" must start with "[NNNN](NNNN-….md)"`);
      continue;
    }
    const number = link[1];
    if (listed.includes(number)) errors.push(`${label}: ADR-${number} is listed more than once`);
    const previous = listed.at(-1);
    if (previous !== undefined && Number(number) < Number(previous)) {
      errors.push(
        `${label}: ADR-${number} is listed after ADR-${previous}; keep the index ordered`,
      );
    }
    listed.push(number);
    const adr = adrs.find((a) => a.number === number);
    if (adr === undefined) {
      errors.push(`${label}: lists ADR-${number}, which does not exist`);
      continue;
    }
    if (link[2] !== adr.file)
      errors.push(`${label}: ADR-${number} links to ${link[2]}, not ${adr.file}`);
    if (titleCell !== adr.title) {
      errors.push(`${label}: ADR-${number} title "${titleCell}" does not match "${adr.title}"`);
    }
    if (stripLinks(statusCell) !== adr.status) {
      errors.push(`${label}: ADR-${number} status "${statusCell}" does not match "${adr.status}"`);
    }
    const listedSections = formatSections(sectionReferences(packCell));
    const citedSections = formatSections(
      adr.cites.flatMap((anchor) => {
        const section = anchorSections.get(anchor);
        return section === undefined ? [] : [section];
      }),
    );
    if (listedSections !== citedSections) {
      errors.push(
        `${label}: ADR-${number} Context Pack column "${packCell}" does not match its References (${citedSections})`,
      );
    }
  }
  for (const adr of adrs) {
    if (!listed.includes(adr.number))
      errors.push(`${label}: index does not list ADR-${adr.number}`);
  }
  return errors;
}

/**
 * Checks docs/adr/ under `root`.
 * @param {string} root repository root
 * @returns {{ ok: boolean, errors: string[], adrs: Array<{ number: string, title: string, status: string, cites: string[] }> }}
 */
export function checkAdrs(root) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Adr[]} */
  const adrs = [];
  const result = () => ({
    ok: errors.length === 0,
    errors,
    adrs: adrs.map(({ number, title, status, cites }) => ({ number, title, status, cites })),
  });

  const dir = path.join(root, ADR_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    errors.push(`${ADR_DIR}: missing`);
    return result();
  }
  const packPath = path.join(root, CONTEXT_PACK);
  if (!existsSync(packPath)) {
    errors.push(`${CONTEXT_PACK}: missing (every ADR cites it)`);
    return result();
  }
  const packText = readFileSync(packPath, 'utf8');
  const packNumbers = packSectionNumbers(packText);
  /** @type {Map<string, Set<string>>} */
  const anchorCache = new Map([[CONTEXT_PACK, headingAnchors(packText)]]);

  /** @type {Map<string, Adr>} */
  const byNumber = new Map();
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (NON_ADR_ENTRIES.includes(entry.name) && entry.isFile()) continue;
    const match = entry.isFile() ? ADR_FILE_PATTERN.exec(entry.name) : null;
    if (match?.[1] === undefined) {
      errors.push(
        `${ADR_DIR}/${entry.name}: unexpected entry (ADRs are NNNN-kebab-case-title.md; also allowed: ${NON_ADR_ENTRIES.join(', ')})`,
      );
      continue;
    }
    const number = match[1];
    const checked = checkAdrFile({ root, file: entry.name, number, packNumbers, anchorCache });
    errors.push(...checked.errors);
    const clash = byNumber.get(number);
    if (clash !== undefined) {
      errors.push(`${entry.name}: number ${number} is already used by ${clash.file}`);
      continue;
    }
    byNumber.set(number, checked.adr);
    adrs.push(checked.adr);
  }

  if (adrs.length === 0) errors.push(`${ADR_DIR}: no ADRs found (numbering starts at 0001)`);
  adrs.sort((a, b) => Number(a.number) - Number(b.number));
  adrs.forEach((adr, index) => {
    const expected = formatNumber(index + 1);
    if (adr.number !== expected) {
      errors.push(`${adr.file}: expected number ${expected}; numbers start at 0001 without gaps`);
    }
  });
  errors.push(...checkSupersession(byNumber));

  // Template.
  const templatePath = path.join(dir, TEMPLATE_FILE);
  if (existsSync(templatePath)) {
    const text = readFileSync(templatePath, 'utf8');
    errors.push(...lintMarkdown(text, TEMPLATE_FILE), ...checkSections(text, TEMPLATE_FILE).errors);
  } else {
    errors.push(`${ADR_DIR}/${TEMPLATE_FILE}: missing (ADR-0001 points at it)`);
  }

  // Index.
  const indexPath = path.join(dir, INDEX_FILE);
  if (existsSync(indexPath)) {
    const text = readFileSync(indexPath, 'utf8');
    errors.push(
      ...lintMarkdown(text, INDEX_FILE),
      ...checkLinks({ root, label: INDEX_FILE, text, anchorCache }).errors,
      ...checkIndex({ text, adrs, anchorSections: packAnchorSections(packText) }),
    );
    for (const ref of sectionReferences(text)) {
      if (!packNumbers.has(ref)) {
        errors.push(`${INDEX_FILE}: references §${ref}, which does not exist in ${CONTEXT_PACK}`);
      }
    }
  } else {
    errors.push(`${ADR_DIR}/${INDEX_FILE}: missing (the ADR index)`);
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
      throw new Error(`unknown argument: ${String(arg)}`);
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
    process.stderr.write(`check-adr: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const result = checkAdrs(args.root);
  if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `check-adr: ${result.errors.length} problem(s) found:\n` +
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
