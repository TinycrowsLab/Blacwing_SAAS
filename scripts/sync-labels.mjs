#!/usr/bin/env node
// Validates the label catalogue (.github/labels.yml, the single source of truth for GitHub
// labels) and synchronises a repository's labels with it (FOUND-016, #18).
//
// The sync is idempotent: it matches labels case-insensitively (as GitHub does), renames
// labels listed under `previously:` in place so issues keep them, only touches labels whose
// color/description/name differ, and never deletes a label unless --prune is passed.
// Every run reports the diff (create / update / rename / delete / unchanged / extra).
//
// Usage: node scripts/sync-labels.mjs [options]
//   --dry-run              validate and list the full catalogue; with a label source, also
//                          print the plan. Never writes anything.
//   --current <file>       compare against a JSON snapshot of the current labels, e.g. the
//                          output of `gh label list --json name,color,description --limit 500`
//                          (always a dry run).
//   --repo <owner/name>    read the live labels through the GitHub REST API; without
//                          --dry-run, apply the plan, then re-read and verify that nothing is
//                          left to change. Needs GITHUB_TOKEN (or GH_TOKEN); GITHUB_API_URL
//                          overrides the API base (as set by GitHub Actions).
//   --prune                also delete labels that are not in the catalogue.
//   --fail-on-diff         exit 1 when the plan is not empty (drift check).
//   --json                 print a machine-readable report instead of text.
//   --write-docs           regenerate the generated table in docs/labels.md.
//   --check-docs           exit 1 when docs/labels.md is out of date with the catalogue.
//   --manifest <file>      catalogue to use (default: .github/labels.yml).
//   --root <dir>           repository root (default: the parent of scripts/).
// Without --repo the script never writes to GitHub.
// Exit codes: 0 ok, 1 invalid catalogue / failed sync / drift / stale docs, 2 usage error.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

export const MANIFEST_PATH = '.github/labels.yml';
export const DOCS_PATH = 'docs/labels.md';
export const DOCS_BEGIN =
  '<!-- BEGIN GENERATED LABEL CATALOGUE: node scripts/sync-labels.mjs --write-docs -->';
export const DOCS_END = '<!-- END GENERATED LABEL CATALOGUE -->';

/** GitHub limits: label names up to 50 characters, descriptions up to 100. */
export const MAX_NAME_LENGTH = 50;
export const MAX_DESCRIPTION_LENGTH = 100;

const COLOR = /^[0-9A-Fa-f]{6}$/;
const GROUP_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// C0/C1 control characters are never valid in a label name or description.
const CONTROL = /\p{Cc}/u;

/** GitHub REST: page size of the label listing, the most pages read, and the request timeout. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
/** How much of a failed response body an error message quotes. */
const ERROR_BODY_LIMIT = 300;
/** Column width of the action in the human-readable plan. */
const ACTION_WIDTH = 6;

const TOP_KEYS = new Set(['version', 'groups']);
const GROUP_KEYS = new Set(['id', 'title', 'description', 'prefix', 'labels']);
const LABEL_KEYS = new Set(['name', 'color', 'description', 'previously']);

/**
 * @typedef {{ name: string, color: string, description: string, previously: string[], group: string }} Label
 * @typedef {{ id: string, title: string, description: string, prefix: string | null, labels: Label[] }} Group
 * @typedef {{ version: 1, groups: Group[], labels: Label[] }} Manifest
 * @typedef {{ name: string, color: string, description: string }} CurrentLabel
 * @typedef {"create" | "update" | "rename" | "delete" | "unchanged" | "extra"} Action
 * @typedef {{ action: Action, name: string, current: CurrentLabel | null, desired: Label | null, changes: string[] }} PlanItem
 * @typedef {{ items: PlanItem[], warnings: string[], counts: Record<Action, number>, pending: number }} Plan
 */

/**
 * Length in Unicode code points (what GitHub counts), not UTF-16 units.
 * @param {string} value
 * @returns {number}
 */
function codePoints(value) {
  return Array.from(value).length;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {Set<string>} allowed
 * @param {string} where
 * @param {string[]} errors
 */
function checkKeys(value, allowed, where, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      errors.push(`${where}: unknown key "${key}" (allowed: ${[...allowed].join(', ')})`);
  }
}

/**
 * Validates a label name and returns it, or null when invalid.
 * @param {unknown} value
 * @param {string} where
 * @param {string[]} errors
 * @returns {string | null}
 */
function checkName(value, where, errors) {
  if (typeof value !== 'string') {
    errors.push(`${where}: name must be a string`);
    return null;
  }
  const before = errors.length;
  if (value.length === 0) errors.push(`${where}: name must not be empty`);
  if (value !== value.trim())
    errors.push(`${where}: name "${value}" has leading or trailing whitespace`);
  if (codePoints(value) > MAX_NAME_LENGTH) {
    errors.push(`${where}: name "${value}" is longer than ${MAX_NAME_LENGTH} characters`);
  }
  if (value.includes(','))
    errors.push(`${where}: name "${value}" must not contain a comma (label lists split on commas)`);
  if (CONTROL.test(value)) errors.push(`${where}: name contains a control character`);
  return errors.length === before ? value : null;
}

/**
 * Validates a parsed catalogue document.
 * @param {unknown} value
 * @returns {{ manifest: Manifest | null, errors: string[] }}
 */
export function validateManifest(value) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(value))
    return { manifest: null, errors: ['catalogue: must be a mapping with `version` and `groups`'] };
  checkKeys(value, TOP_KEYS, 'catalogue', errors);
  if (value.version !== 1)
    errors.push(`catalogue: "version" must be 1, found ${JSON.stringify(value.version)}`);
  if (!Array.isArray(value.groups) || value.groups.length === 0) {
    errors.push('catalogue: `groups` must be a non-empty list');
    return { manifest: null, errors };
  }

  /** @type {Group[]} */
  const groups = [];
  /** @type {Label[]} */
  const labels = [];
  /** @type {Map<string, string>} lowercased name or previous name -> where it is declared */
  const claimed = new Map();
  /** @type {Set<string>} */
  const groupIds = new Set();

  /**
   * @param {string} name
   * @param {string} where
   */
  const claim = (name, where) => {
    const key = name.toLowerCase();
    const other = claimed.get(key);
    if (other !== undefined) {
      errors.push(
        `${where}: "${name}" collides with ${other} (label names are case-insensitive on GitHub)`,
      );
    } else {
      claimed.set(key, `${where} ("${name}")`);
    }
  };

  value.groups.forEach((rawGroup, gi) => {
    const gWhere = `groups[${gi}]`;
    if (!isRecord(rawGroup)) {
      errors.push(`${gWhere}: must be a mapping`);
      return;
    }
    checkKeys(rawGroup, GROUP_KEYS, gWhere, errors);
    const id = typeof rawGroup.id === 'string' ? rawGroup.id : '';
    if (!GROUP_ID.test(id))
      errors.push(
        `${gWhere}: id must be lowercase kebab-case, found ${JSON.stringify(rawGroup.id)}`,
      );
    else if (groupIds.has(id)) errors.push(`${gWhere}: duplicate group id "${id}"`);
    groupIds.add(id);
    const where = id === '' ? gWhere : `group "${id}"`;
    if (typeof rawGroup.title !== 'string' || rawGroup.title.trim() === '')
      errors.push(`${where}: title must be a non-empty string`);
    if (typeof rawGroup.description !== 'string' || rawGroup.description.trim() === '') {
      errors.push(`${where}: description must be a non-empty string`);
    }
    let prefix = null;
    if (rawGroup.prefix !== undefined) {
      if (typeof rawGroup.prefix !== 'string' || rawGroup.prefix === '')
        errors.push(`${where}: prefix must be a non-empty string when set`);
      else prefix = rawGroup.prefix;
    }
    /** @type {Group} */
    const group = {
      id,
      title: typeof rawGroup.title === 'string' ? rawGroup.title : '',
      description: typeof rawGroup.description === 'string' ? rawGroup.description.trim() : '',
      prefix,
      labels: [],
    };
    groups.push(group);
    if (!Array.isArray(rawGroup.labels) || rawGroup.labels.length === 0) {
      errors.push(`${where}: labels must be a non-empty list`);
      return;
    }
    rawGroup.labels.forEach((rawLabel, li) => {
      const lWhere = `${where} labels[${li}]`;
      if (!isRecord(rawLabel)) {
        errors.push(`${lWhere}: must be a mapping`);
        return;
      }
      checkKeys(rawLabel, LABEL_KEYS, lWhere, errors);
      const name = checkName(rawLabel.name, lWhere, errors);
      const at = name === null ? lWhere : `label "${name}"`;
      if (name !== null) {
        claim(name, at);
        if (prefix !== null && !name.startsWith(prefix))
          errors.push(`${at}: must start with the group prefix "${prefix}"`);
      }
      let color = '';
      if (typeof rawLabel.color !== 'string') {
        errors.push(
          `${at}: color must be a quoted string of 6 hex digits, found ${JSON.stringify(rawLabel.color)} ` +
            '(unquoted values such as 000000 or 1E1234 parse as numbers)',
        );
      } else if (!COLOR.test(rawLabel.color)) {
        errors.push(`${at}: color must be 6 hex digits without "#", found "${rawLabel.color}"`);
      } else {
        color = rawLabel.color.toUpperCase();
      }
      let description = '';
      if (typeof rawLabel.description !== 'string' || rawLabel.description.trim() === '') {
        errors.push(`${at}: description must be a non-empty string`);
      } else {
        description = rawLabel.description;
        if (description !== description.trim())
          errors.push(`${at}: description has leading or trailing whitespace`);
        if (codePoints(description) > MAX_DESCRIPTION_LENGTH) {
          errors.push(
            `${at}: description is ${codePoints(description)} characters, GitHub allows ${MAX_DESCRIPTION_LENGTH}`,
          );
        }
        if (CONTROL.test(description))
          errors.push(`${at}: description contains a control character`);
      }
      /** @type {string[]} */
      const previously = [];
      if (rawLabel.previously !== undefined) {
        if (!Array.isArray(rawLabel.previously)) {
          errors.push(`${at}: previously must be a list of former names`);
        } else {
          rawLabel.previously.forEach((old, oi) => {
            const oldName = checkName(old, `${at} previously[${oi}]`, errors);
            if (oldName === null) return;
            if (name !== null && oldName.toLowerCase() === name.toLowerCase()) {
              errors.push(
                `${at}: previously lists the label's own name "${oldName}" (case-only renames need no entry)`,
              );
              return;
            }
            claim(oldName, `${at} previously`);
            previously.push(oldName);
          });
        }
      }
      if (name === null) return;
      /** @type {Label} */
      const label = { name, color, description, previously, group: id };
      group.labels.push(label);
      labels.push(label);
    });
  });

  return errors.length === 0
    ? { manifest: { version: 1, groups, labels }, errors }
    : { manifest: null, errors };
}

/**
 * Parses and validates catalogue YAML text.
 * @param {string} text
 * @returns {{ manifest: Manifest | null, errors: string[] }}
 */
export function parseManifest(text) {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      manifest: null,
      errors: doc.errors.map((e) => `invalid YAML: ${e.message.split('\n')[0] ?? e.message}`),
    };
  }
  /** @type {unknown} */
  let value;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return {
      manifest: null,
      errors: [
        `invalid YAML: ${error instanceof Error ? error.message : String(error)} (anchors and aliases are not allowed)`,
      ],
    };
  }
  return validateManifest(value);
}

/**
 * @param {string} file
 * @returns {{ manifest: Manifest | null, errors: string[] }}
 */
export function loadManifest(file) {
  if (!existsSync(file)) return { manifest: null, errors: [`${file}: missing`] };
  return parseManifest(readFileSync(file, 'utf8'));
}

/**
 * Validates labels read from GitHub or from a snapshot file.
 * @param {unknown} value
 * @param {string} source
 * @returns {CurrentLabel[]}
 */
export function parseCurrentLabels(value, source) {
  if (!Array.isArray(value)) throw new Error(`${source}: expected a JSON array of labels`);
  return value.map((item, i) => {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') {
      throw new Error(`${source}[${i}]: expected an object with a non-empty string "name"`);
    }
    if (typeof item.color !== 'string')
      throw new Error(`${source}[${i}] ("${item.name}"): "color" must be a string`);
    if (
      item.description !== undefined &&
      item.description !== null &&
      typeof item.description !== 'string'
    ) {
      throw new Error(`${source}[${i}] ("${item.name}"): "description" must be a string or null`);
    }
    return {
      name: item.name,
      color: item.color.replace(/^#/, ''),
      description: typeof item.description === 'string' ? item.description : '',
    };
  });
}

/**
 * Field differences between a current label and its desired state.
 * @param {CurrentLabel} current
 * @param {Label} desired
 * @returns {string[]}
 */
function diffFields(current, desired) {
  /** @type {string[]} */
  const changes = [];
  if (current.name !== desired.name) changes.push(`name: "${current.name}" -> "${desired.name}"`);
  if (current.color.toUpperCase() !== desired.color)
    changes.push(`color: ${current.color.toUpperCase()} -> ${desired.color}`);
  if (current.description !== desired.description) {
    changes.push(
      `description: ${JSON.stringify(current.description)} -> ${JSON.stringify(desired.description)}`,
    );
  }
  return changes;
}

/**
 * Computes the changes needed to make `current` match the catalogue. Pure and deterministic.
 * @param {Label[]} desired
 * @param {CurrentLabel[]} current
 * @param {{ prune?: boolean }} [options]
 * @returns {Plan}
 */
export function planSync(desired, current, options = {}) {
  /** @type {Map<string, CurrentLabel>} */
  const byName = new Map();
  /** @type {string[]} */
  const warnings = [];
  for (const label of current) {
    const key = label.name.toLowerCase();
    if (byName.has(key))
      warnings.push(
        `current labels contain "${label.name}" twice (ignoring case); using the first`,
      );
    else byName.set(key, label);
  }
  /** @type {Set<string>} */
  const claimed = new Set();
  /** @type {PlanItem[]} */
  const items = [];

  for (const label of desired) {
    const exact = byName.get(label.name.toLowerCase());
    if (exact !== undefined) {
      claimed.add(exact.name.toLowerCase());
      const changes = diffFields(exact, label);
      items.push({
        action: changes.length === 0 ? 'unchanged' : 'update',
        name: label.name,
        current: exact,
        desired: label,
        changes,
      });
      for (const old of label.previously) {
        if (byName.has(old.toLowerCase())) {
          warnings.push(
            `"${old}" (a previous name of "${label.name}") still exists next to it; move its issues to "${label.name}", then delete it or run with --prune`,
          );
        }
      }
      continue;
    }
    const former = label.previously
      .map((old) => byName.get(old.toLowerCase()))
      .find((found) => found !== undefined && !claimed.has(found.name.toLowerCase()));
    if (former !== undefined) {
      claimed.add(former.name.toLowerCase());
      items.push({
        action: 'rename',
        name: label.name,
        current: former,
        desired: label,
        changes: diffFields(former, label),
      });
      continue;
    }
    items.push({ action: 'create', name: label.name, current: null, desired: label, changes: [] });
  }

  for (const label of current) {
    const key = label.name.toLowerCase();
    if (claimed.has(key) || byName.get(key) !== label) continue;
    items.push({
      action: options.prune === true ? 'delete' : 'extra',
      name: label.name,
      current: label,
      desired: null,
      changes: [],
    });
  }

  /** @type {Record<Action, number>} */
  const counts = { create: 0, update: 0, rename: 0, delete: 0, unchanged: 0, extra: 0 };
  for (const item of items) counts[item.action] += 1;
  return {
    items,
    warnings,
    counts,
    pending: counts.create + counts.update + counts.rename + counts.delete,
  };
}

/**
 * @typedef {{
 *   listLabels: () => Promise<CurrentLabel[]>,
 *   createLabel: (label: { name: string, color: string, description: string }) => Promise<void>,
 *   updateLabel: (currentName: string, patch: { new_name: string, color: string, description: string }) => Promise<void>,
 *   deleteLabel: (name: string) => Promise<void>,
 * }} LabelClient
 */

/**
 * Applies a plan through a label client, one change at a time. Stops at the first failure
 * and reports what was applied, so a re-run (which re-plans) picks up where it stopped.
 * @param {Plan} plan
 * @param {LabelClient} client
 * @returns {Promise<{ applied: Array<{ action: Action, name: string }>, failed: { action: Action, name: string, error: string } | null }>}
 */
export async function applyPlan(plan, client) {
  /** @type {Array<{ action: Action, name: string }>} */
  const applied = [];
  for (const item of plan.items) {
    try {
      if (item.action === 'create' && item.desired !== null) {
        await client.createLabel({
          name: item.desired.name,
          color: item.desired.color,
          description: item.desired.description,
        });
      } else if (
        (item.action === 'update' || item.action === 'rename') &&
        item.desired !== null &&
        item.current !== null
      ) {
        await client.updateLabel(item.current.name, {
          new_name: item.desired.name,
          color: item.desired.color,
          description: item.desired.description,
        });
      } else if (item.action === 'delete' && item.current !== null) {
        await client.deleteLabel(item.current.name);
      } else {
        continue;
      }
      applied.push({ action: item.action, name: item.name });
    } catch (error) {
      return {
        applied,
        failed: {
          action: item.action,
          name: item.name,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  return { applied, failed: null };
}

/**
 * GitHub REST label client. The token is sent only in the Authorization header and is
 * never included in errors or output.
 * @param {{ repo: string, token: string, apiUrl?: string, fetchImpl?: typeof fetch }} options
 * @returns {LabelClient}
 */
export function createGitHubClient(options) {
  if (!REPO.test(options.repo))
    throw new Error(`--repo must look like owner/name, found "${options.repo}"`);
  if (options.token === '')
    throw new Error('a GitHub token is required (GITHUB_TOKEN or GH_TOKEN)');
  const base = `${(options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')}/repos/${options.repo}/labels`;
  const doFetch = options.fetchImpl ?? fetch;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${options.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'blackwing-sync-labels',
  };

  /**
   * @param {string} method
   * @param {string} url
   * @param {unknown} [body]
   * @returns {Promise<unknown>}
   */
  const request = async (method, url, body) => {
    const response = await doFetch(url, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, ERROR_BODY_LIMIT);
      try {
        /** @type {unknown} */
        const parsed = JSON.parse(text);
        if (isRecord(parsed) && typeof parsed.message === 'string') message = parsed.message;
      } catch {
        // keep the raw (truncated) body
      }
      throw new Error(
        `GitHub API ${method} ${new URL(url).pathname} failed: ${response.status} ${message}`,
      );
    }
    return text === '' ? null : /** @type {unknown} */ (JSON.parse(text));
  };

  /** @param {string} name */
  const labelUrl = (name) => `${base}/${encodeURIComponent(name)}`;

  return {
    async listLabels() {
      /** @type {CurrentLabel[]} */
      const all = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = parseCurrentLabels(
          await request('GET', `${base}?per_page=${PAGE_SIZE}&page=${page}`),
          'GitHub labels',
        );
        all.push(...batch);
        if (batch.length < PAGE_SIZE) return all;
      }
      throw new Error(
        `GitHub labels: more than ${PAGE_SIZE * MAX_PAGES} labels, refusing to continue`,
      );
    },
    async createLabel(label) {
      await request('POST', base, label);
    },
    async updateLabel(currentName, patch) {
      await request('PATCH', labelUrl(currentName), patch);
    },
    async deleteLabel(name) {
      await request('DELETE', labelUrl(name));
    },
  };
}

/**
 * Escapes a value for a Markdown table cell.
 * @param {string} value
 * @returns {string}
 */
function cell(value) {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Renders the generated catalogue section of docs/labels.md (between the markers).
 * @param {Manifest} manifest
 * @returns {string}
 */
export function renderDocsTable(manifest) {
  const lines = [
    DOCS_BEGIN,
    '',
    `_Generated from \`${MANIFEST_PATH}\`: ${manifest.labels.length} labels in ${manifest.groups.length} groups. Do not edit by hand._`,
  ];
  for (const group of manifest.groups) {
    lines.push(
      '',
      `### ${group.title} (\`${group.id}\`, ${group.labels.length})`,
      '',
      group.description,
      '',
    );
    const withPrevious = group.labels.some((l) => l.previously.length > 0);
    lines.push(
      withPrevious
        ? '| Label | Color | Description | Previously |'
        : '| Label | Color | Description |',
    );
    lines.push(withPrevious ? '|---|---|---|---|' : '|---|---|---|');
    for (const label of group.labels) {
      const row = [`\`${cell(label.name)}\``, `\`#${label.color}\``, cell(label.description)];
      if (withPrevious) row.push(label.previously.map((p) => `\`${cell(p)}\``).join(', '));
      lines.push(`| ${row.join(' | ')} |`);
    }
  }
  lines.push('', DOCS_END);
  return lines.join('\n');
}

/**
 * Replaces the generated section of a docs file.
 * @param {string} docs
 * @param {Manifest} manifest
 * @returns {string}
 */
export function updateDocs(docs, manifest) {
  const start = docs.indexOf(DOCS_BEGIN);
  const end = docs.indexOf(DOCS_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${DOCS_PATH}: generated-section markers are missing or out of order`);
  }
  return docs.slice(0, start) + renderDocsTable(manifest) + docs.slice(end + DOCS_END.length);
}

/**
 * Text listing of the full catalogue.
 * @param {Manifest} manifest
 * @param {string} source
 * @returns {string}
 */
export function formatCatalogue(manifest, source) {
  const width = Math.max(...manifest.labels.map((l) => codePoints(l.name)));
  const lines = [
    `Label catalogue ${source}: ${manifest.labels.length} labels in ${manifest.groups.length} groups (valid)`,
  ];
  for (const group of manifest.groups) {
    lines.push('', `${group.id} (${group.labels.length}): ${group.title}`);
    for (const label of group.labels) {
      lines.push(
        `  ${label.name.padEnd(width + (label.name.length - codePoints(label.name)))}  #${label.color}  ${label.description}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Text rendering of a plan.
 * @param {Plan} plan
 * @param {string} against
 * @returns {string}
 */
export function formatPlan(plan, against) {
  const c = plan.counts;
  const lines = [
    `Plan against ${against}: ${c.create} to create, ${c.update} to update, ${c.rename} to rename, ` +
      `${c.delete} to delete, ${c.unchanged} unchanged, ${c.extra} extra (kept; --prune deletes them)`,
  ];
  for (const item of plan.items) {
    if (item.action === 'unchanged') continue;
    const from =
      item.action === 'rename' && item.current !== null ? ` (from "${item.current.name}")` : '';
    lines.push(`  ${item.action.padEnd(ACTION_WIDTH)}  ${item.name}${from}`);
    for (const change of item.changes) lines.push(`          ${change}`);
  }
  for (const warning of plan.warnings) lines.push(`  warning: ${warning}`);
  if (plan.pending === 0) lines.push('  nothing to change');
  return lines.join('\n');
}

/**
 * @param {Plan} plan
 */
function planJson(plan) {
  return {
    counts: plan.counts,
    pending: plan.pending,
    warnings: plan.warnings,
    changes: plan.items
      .filter((i) => i.action !== 'unchanged')
      .map((i) => ({
        action: i.action,
        name: i.name,
        from: i.current?.name ?? null,
        changes: i.changes,
      })),
  };
}

/**
 * @typedef {{
 *   dryRun: boolean, current: string | null, repo: string | null, prune: boolean, failOnDiff: boolean,
 *   json: boolean, writeDocs: boolean, checkDocs: boolean, manifest: string | null, root: string,
 * }} Args
 */

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Args} */
  const args = {
    dryRun: false,
    current: null,
    repo: null,
    prune: false,
    failOnDiff: false,
    json: false,
    writeDocs: false,
    checkDocs: false,
    manifest: null,
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  };
  /**
   * @param {number} i
   * @param {string} flag
   * @returns {string}
   */
  const valueAt = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--prune') args.prune = true;
    else if (arg === '--fail-on-diff') args.failOnDiff = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--write-docs') args.writeDocs = true;
    else if (arg === '--check-docs') args.checkDocs = true;
    else if (arg === '--current') args.current = valueAt(i++, arg);
    else if (arg === '--repo') args.repo = valueAt(i++, arg);
    else if (arg === '--manifest') args.manifest = valueAt(i++, arg);
    else if (arg === '--root') args.root = path.resolve(valueAt(i++, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.current !== null && args.repo !== null)
    throw new Error('pass either --current or --repo, not both');
  if (args.writeDocs && args.checkDocs)
    throw new Error('pass either --write-docs or --check-docs, not both');
  return args;
}

/**
 * @typedef {{
 *   env?: Record<string, string | undefined>,
 *   stdout?: (text: string) => void,
 *   stderr?: (text: string) => void,
 *   fetchImpl?: typeof fetch,
 * }} Io
 */

/**
 * CLI entry point.
 * @param {string[]} argv
 * @param {Io} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.stdout ?? ((text) => void process.stdout.write(text));
  const err = io.stderr ?? ((text) => void process.stderr.write(text));
  /** @param {string} message */
  const fail = (message) => {
    err(`sync-labels: ${message}\n`);
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const manifestFile =
    args.manifest === null ? path.join(args.root, MANIFEST_PATH) : path.resolve(args.manifest);
  const source = path.relative(args.root, manifestFile) || manifestFile;
  const { manifest, errors } = loadManifest(manifestFile);
  if (manifest === null) {
    fail(
      `${source} is invalid (${errors.length} problem(s)):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
    return 1;
  }

  if (args.writeDocs || args.checkDocs) {
    const docsFile = path.join(args.root, DOCS_PATH);
    if (!existsSync(docsFile)) {
      fail(`${DOCS_PATH}: missing`);
      return 1;
    }
    const docs = readFileSync(docsFile, 'utf8');
    let next;
    try {
      next = updateDocs(docs, manifest);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (args.checkDocs) {
      if (next !== docs) {
        fail(
          `${DOCS_PATH} is out of date with ${source}; run: node scripts/sync-labels.mjs --write-docs`,
        );
        return 1;
      }
      out(`${DOCS_PATH} is up to date with ${source}\n`);
      return 0;
    }
    if (next !== docs) writeFileSync(docsFile, next);
    out(`${DOCS_PATH} ${next === docs ? 'already up to date' : 'regenerated'} from ${source}\n`);
    return 0;
  }

  /** @type {CurrentLabel[] | null} */
  let current = null;
  let against = '';
  /** @type {LabelClient | null} */
  let client = null;
  try {
    if (args.current !== null) {
      against = args.current;
      current = parseCurrentLabels(
        JSON.parse(readFileSync(path.resolve(args.current), 'utf8')),
        args.current,
      );
    } else if (args.repo !== null) {
      against = `github.com/${args.repo}`;
      client = createGitHubClient({
        repo: args.repo,
        token: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '',
        ...(env.GITHUB_API_URL === undefined ? {} : { apiUrl: env.GITHUB_API_URL }),
        ...(io.fetchImpl === undefined ? {} : { fetchImpl: io.fetchImpl }),
      });
      current = await client.listLabels();
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const plan = current === null ? null : planSync(manifest.labels, current, { prune: args.prune });
  const apply = client !== null && plan !== null && !args.dryRun;
  /** @type {Awaited<ReturnType<typeof applyPlan>> | null} */
  let result = null;
  /** @type {Plan | null} */
  let verify = null;
  if (apply && client !== null) {
    result = await applyPlan(plan, client);
    if (result.failed === null) {
      try {
        verify = planSync(manifest.labels, await client.listLabels(), { prune: args.prune });
      } catch (error) {
        fail(
          `re-reading labels after the sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }
    }
  }

  /** @type {string | null} */
  let problem = null;
  if (result?.failed) {
    problem = `${result.failed.action} "${result.failed.name}" failed: ${result.failed.error} (re-run to continue; the sync is idempotent)`;
  } else if (verify !== null && verify.pending > 0) {
    problem = `labels still differ after the sync (${verify.pending} change(s) pending)`;
  } else if (args.failOnDiff && plan !== null && !apply && plan.pending > 0) {
    problem = `${against} differs from ${source} (${plan.pending} change(s) pending)`;
  }

  if (args.json) {
    out(
      `${JSON.stringify(
        {
          ok: problem === null,
          manifest: source,
          mode: apply ? 'apply' : 'dry-run',
          groups: manifest.groups.map((g) => ({
            id: g.id,
            title: g.title,
            count: g.labels.length,
          })),
          labels: manifest.labels.map((l) => ({
            name: l.name,
            color: l.color,
            description: l.description,
            group: l.group,
          })),
          against: plan === null ? null : against,
          plan: plan === null ? null : planJson(plan),
          applied: result?.applied ?? null,
          failed: result?.failed ?? null,
          remaining: verify === null ? null : verify.pending,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    out(`${formatCatalogue(manifest, source)}\n\n`);
    if (plan === null)
      out(
        'No current labels given (--current <file> or --repo <owner/name>): catalogue validated, nothing compared.\n',
      );
    else out(`${formatPlan(plan, against)}\n`);
    if (result !== null) out(`Applied ${result.applied.length} change(s).\n`);
    if (verify !== null)
      out(
        `Verification: ${verify.pending === 0 ? 'repository labels match the catalogue' : `${verify.pending} change(s) still pending`}\n`,
      );
  }

  if (problem !== null) {
    fail(problem);
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // A closed pipe (e.g. `| head`) is not an error for a listing command.
  process.stdout.on('error', (/** @type {Error} */ error) => {
    if ('code' in error && error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw error;
  });
  process.exitCode = await main(process.argv.slice(2));
}
