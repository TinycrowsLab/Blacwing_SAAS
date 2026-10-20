#!/usr/bin/env node
// Checks the GitHub collaboration assets added by FOUND-016 (#18) against each other and
// against docs/architecture/CONTEXT_PACK.md:
//
//   - issue forms (.github/ISSUE_TEMPLATE/*.yml) follow the GitHub issue-forms schema rules
//     that GitHub only reports when someone opens the form (unique ids/labels, non-empty and
//     distinct dropdown options, the reserved option "None", ...);
//   - the Task form captures key, size, priority, features and depends_on (plus epic and
//     area), and its dropdowns list exactly the values of the matching label groups;
//   - every label a form applies exists in the label catalogue (.github/labels.yml);
//   - config.yml disables blank issues and routes vulnerabilities to private reporting;
//   - the PR template has the required sections, a `Closes #` prompt and the CONTEXT_PACK
//     §10 Definition of Done checklist verbatim;
//   - CODEOWNERS uses only syntax GitHub supports, names only owners listed in the registry
//     in docs/runbooks/code-owners.md, routes the security-owned paths to the security
//     owners (last matching rule wins) and carries the OFFLINE-STUB marker while any owner
//     is still a placeholder.
//
// Usage: node scripts/check-github.mjs [--root <dir>] [--quiet]
// Prints a structured JSON summary on stdout; exits non-zero when any check fails.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

import { MANIFEST_PATH, loadManifest } from "./sync-labels.mjs";

export const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
export const PR_TEMPLATE = ".github/PULL_REQUEST_TEMPLATE.md";
export const CODEOWNERS = ".github/CODEOWNERS";
export const OWNER_REGISTRY = "docs/runbooks/code-owners.md";
export const CONTEXT_PACK = "docs/architecture/CONTEXT_PACK.md";

/** Issue forms that must exist (config.yml is checked separately). */
export const ISSUE_FORMS = Object.freeze(["task.yml", "bug.yml"]);

/** Fields the Task form must capture as required inputs (FOUND-016 requirement 4). */
export const TASK_REQUIRED_FIELDS = Object.freeze(["key", "epic", "area", "priority", "size", "features", "depends_on"]);

/** Fields the Bug form must capture (optional there, confirmed at triage). */
export const BUG_FIELDS = Object.freeze(["key", "priority", "size", "features", "depends_on"]);

/** Level-2 headings of the PR template, in order (FOUND-016 requirement 1). */
export const PR_SECTIONS = Object.freeze([
  "Summary",
  "Linked issue",
  "Acceptance criteria",
  "Definition of Done",
  "Security considerations",
  "Test evidence",
]);

export const SECURITY_OWNERS = "@TinycrowsLab/blackwing-security-owners";

/** Sample files under each security-owned path that must resolve to the security owners. */
export const SECURITY_OWNED_SAMPLES = Object.freeze([
  "apps/egress-gateway/go.mod",
  "apps/egress-gateway/internal/proxy/proxy.go",
  "packages/policy/src/index.ts",
  "packages/policy/schema/blackwing.cedarschema",
  "packages/crypto/src/envelope.ts",
  "packages/secrets/src/index.ts",
  "packages/audit/src/ledger.ts",
  ".github/CODEOWNERS",
  ".github/workflows/ci.yml",
  "SECURITY.md",
  ".gitleaks.toml",
  ".trivyignore",
]);

const FORM_KEYS = new Set(["name", "description", "title", "labels", "assignees", "projects", "type", "body"]);
const ELEMENT_TYPES = new Set(["markdown", "textarea", "input", "dropdown", "checkboxes"]);
const ELEMENT_ID = /^[A-Za-z0-9_-]+$/;
const OWNER = /^(@[A-Za-z0-9-]+(\/[A-Za-z0-9_.-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} file
 * @param {string} rel
 * @param {string[]} errors
 * @returns {unknown}
 */
function readYaml(file, rel, errors) {
  if (!existsSync(file)) {
    errors.push(`${rel}: missing`);
    return null;
  }
  const doc = parseDocument(readFileSync(file, "utf8"), { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) errors.push(`${rel}: invalid YAML (${e.message.split("\n")[0] ?? e.message})`);
    return null;
  }
  return doc.toJS();
}

/**
 * Same slug rule the label catalogue uses for areas: "Authorisation & Policy" -> "authorisation-policy".
 * @param {string} text
 * @returns {string}
 */
export function areaSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * @typedef {{ type: string, id: string | null, label: string | null, required: boolean, options: string[], multiple: boolean }} FormField
 * @typedef {{ name: string, labels: string[], fields: FormField[] }} IssueForm
 */

/**
 * Validates one issue form against the GitHub issue-forms rules.
 * @param {unknown} value
 * @param {string} rel
 * @param {string[]} errors
 * @returns {IssueForm | null}
 */
export function validateIssueForm(value, rel, errors) {
  if (!isRecord(value)) {
    errors.push(`${rel}: must be a mapping`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!FORM_KEYS.has(key)) errors.push(`${rel}: unknown top-level key "${key}"`);
  }
  for (const key of ["name", "description"]) {
    if (typeof value[key] !== "string" || value[key].trim() === "") errors.push(`${rel}: "${key}" must be a non-empty string`);
  }
  /** @type {string[]} */
  const labels = [];
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels) || value.labels.some((l) => typeof l !== "string")) {
      errors.push(`${rel}: "labels" must be a list of label names`);
    } else {
      labels.push(...value.labels);
    }
  }
  if (!Array.isArray(value.body) || value.body.length === 0) {
    errors.push(`${rel}: "body" must be a non-empty list`);
    return null;
  }
  /** @type {FormField[]} */
  const fields = [];
  const ids = new Set();
  const fieldLabels = new Set();
  let inputs = 0;
  value.body.forEach((element, i) => {
    const where = `${rel} body[${i}]`;
    if (!isRecord(element) || typeof element.type !== "string" || !ELEMENT_TYPES.has(element.type)) {
      errors.push(`${where}: "type" must be one of ${[...ELEMENT_TYPES].join(", ")}`);
      return;
    }
    const attributes = isRecord(element.attributes) ? element.attributes : null;
    if (attributes === null) {
      errors.push(`${where}: "attributes" must be a mapping`);
      return;
    }
    /** @type {string | null} */
    let id = null;
    if (element.id !== undefined) {
      if (typeof element.id !== "string" || !ELEMENT_ID.test(element.id)) {
        errors.push(`${where}: id must match ${ELEMENT_ID}, found ${JSON.stringify(element.id)}`);
      } else if (ids.has(element.id)) {
        errors.push(`${where}: duplicate id "${element.id}"`);
      } else {
        ids.add(element.id);
        id = element.id;
      }
    }
    if (element.type === "markdown") {
      if (typeof attributes.value !== "string" || attributes.value.trim() === "") errors.push(`${where}: markdown needs a non-empty "value"`);
      return;
    }
    inputs += 1;
    const label = typeof attributes.label === "string" && attributes.label.trim() !== "" ? attributes.label : null;
    if (label === null) errors.push(`${where}: "label" must be a non-empty string`);
    else if (fieldLabels.has(label.toLowerCase())) errors.push(`${where}: duplicate label "${label}"`);
    else fieldLabels.add(label.toLowerCase());
    const validations = isRecord(element.validations) ? element.validations : {};
    if (validations.required !== undefined && typeof validations.required !== "boolean") {
      errors.push(`${where}: validations.required must be a boolean`);
    }
    /** @type {string[]} */
    const options = [];
    if (element.type === "dropdown") {
      if (!Array.isArray(attributes.options) || attributes.options.length === 0) {
        errors.push(`${where}: dropdown "options" must be a non-empty list`);
      } else {
        const seen = new Set();
        for (const option of attributes.options) {
          if (typeof option !== "string" || option.trim() === "") {
            errors.push(`${where}: dropdown options must be non-empty strings, found ${JSON.stringify(option)}`);
            continue;
          }
          if (option.trim().toLowerCase() === "none") errors.push(`${where}: "None" is a reserved dropdown option on GitHub`);
          if (seen.has(option)) errors.push(`${where}: duplicate dropdown option "${option}"`);
          seen.add(option);
          options.push(option);
        }
      }
    }
    if (element.type === "checkboxes") {
      if (!Array.isArray(attributes.options) || attributes.options.length === 0) {
        errors.push(`${where}: checkboxes "options" must be a non-empty list`);
      } else {
        for (const option of attributes.options) {
          if (!isRecord(option) || typeof option.label !== "string" || option.label.trim() === "") {
            errors.push(`${where}: each checkbox needs a non-empty "label"`);
          } else {
            options.push(option.label);
          }
        }
      }
    }
    fields.push({
      type: element.type,
      id,
      label,
      required: validations.required === true,
      options,
      multiple: attributes.multiple === true,
    });
  });
  if (inputs === 0) errors.push(`${rel}: needs at least one non-markdown field`);
  return { name: typeof value.name === "string" ? value.name : "", labels, fields };
}

/**
 * Asserts that a dropdown lists exactly the values of a label group.
 * @param {IssueForm} form
 * @param {string} rel
 * @param {string} fieldId
 * @param {string[]} expected
 * @param {string[]} errors
 */
function checkDropdown(form, rel, fieldId, expected, errors) {
  const field = form.fields.find((f) => f.id === fieldId);
  if (field === undefined) return; // reported by the required-field check
  if (field.type !== "dropdown") {
    errors.push(`${rel}: field "${fieldId}" must be a dropdown`);
    return;
  }
  const missing = expected.filter((v) => !field.options.includes(v));
  const extra = field.options.filter((v) => !expected.includes(v));
  if (missing.length > 0 || extra.length > 0) {
    errors.push(
      `${rel}: "${fieldId}" options drift from ${MANIFEST_PATH}` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; not in the catalogue: ${extra.join(", ")}` : ""),
    );
  }
}

/**
 * @param {string} root
 * @param {Set<string>} labelNames
 * @param {import("./sync-labels.mjs").Manifest | null} manifest
 * @param {string[]} errors
 */
function checkIssueTemplates(root, labelNames, manifest, errors) {
  /** @type {Record<string, IssueForm>} */
  const forms = {};
  for (const file of ISSUE_FORMS) {
    const rel = `${TEMPLATE_DIR}/${file}`;
    const value = readYaml(path.join(root, rel), rel, errors);
    if (value === null) continue;
    const form = validateIssueForm(value, rel, errors);
    if (form === null) continue;
    forms[file] = form;
    if (manifest !== null) {
      for (const label of form.labels) {
        if (!labelNames.has(label.toLowerCase())) errors.push(`${rel}: applies label "${label}", which is not in ${MANIFEST_PATH}`);
      }
    }
  }

  const task = forms["task.yml"];
  if (task !== undefined) {
    const rel = `${TEMPLATE_DIR}/task.yml`;
    if (!task.labels.includes("type:task")) errors.push(`${rel}: must apply the "type:task" label`);
    for (const id of TASK_REQUIRED_FIELDS) {
      const field = task.fields.find((f) => f.id === id);
      if (field === undefined) errors.push(`${rel}: missing the "${id}" field`);
      else if (!field.required) errors.push(`${rel}: the "${id}" field must be required`);
    }
    if (manifest !== null) {
      /** @param {string} groupId */
      const group = (groupId) => manifest.groups.find((g) => g.id === groupId);
      const strip = (/** @type {string} */ prefix, /** @type {string} */ groupId) =>
        (group(groupId)?.labels ?? []).map((l) => l.name.slice(prefix.length));
      checkDropdown(task, rel, "priority", strip("priority:", "priority"), errors);
      checkDropdown(task, rel, "size", strip("size:", "size"), errors);
      checkDropdown(task, rel, "epic", strip("epic:", "epic"), errors);
      const area = task.fields.find((f) => f.id === "area");
      if (area !== undefined) {
        const slugs = area.options.map((o) => `area:${areaSlug(o)}`);
        const expected = (group("area")?.labels ?? []).map((l) => l.name);
        const missing = expected.filter((n) => !slugs.includes(n));
        const extra = area.options.filter((o) => !expected.includes(`area:${areaSlug(o)}`));
        if (missing.length > 0 || extra.length > 0) {
          errors.push(
            `${rel}: "area" options drift from ${MANIFEST_PATH}` +
              (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
              (extra.length > 0 ? `; not in the catalogue: ${extra.join(", ")}` : ""),
          );
        }
      }
    }
  }

  const bug = forms["bug.yml"];
  if (bug !== undefined) {
    const rel = `${TEMPLATE_DIR}/bug.yml`;
    if (!bug.labels.includes("bug")) errors.push(`${rel}: must apply the "bug" label`);
    for (const id of BUG_FIELDS) {
      if (!bug.fields.some((f) => f.id === id)) errors.push(`${rel}: missing the "${id}" field`);
    }
    const preflight = bug.fields.find((f) => f.type === "checkboxes" && f.options.some((o) => /security vulnerabilit/i.test(o)));
    if (preflight === undefined) errors.push(`${rel}: needs a checkbox confirming the report is not a security vulnerability`);
    if (manifest !== null) {
      for (const [id, prefix] of /** @type {const} */ ([["priority", "priority:"], ["size", "size:"]])) {
        const groupLabels = manifest.groups.find((g) => g.id === id)?.labels ?? [];
        checkDropdown(bug, rel, id, groupLabels.map((l) => l.name.slice(prefix.length)), errors);
      }
    }
  }

  const configRel = `${TEMPLATE_DIR}/config.yml`;
  const config = readYaml(path.join(root, configRel), configRel, errors);
  if (config !== null) {
    if (!isRecord(config)) {
      errors.push(`${configRel}: must be a mapping`);
    } else {
      if (config.blank_issues_enabled !== false) errors.push(`${configRel}: blank_issues_enabled must be false`);
      const links = Array.isArray(config.contact_links) ? config.contact_links : [];
      for (const [i, link] of links.entries()) {
        if (!isRecord(link) || ["name", "url", "about"].some((k) => typeof link[k] !== "string" || link[k] === "")) {
          errors.push(`${configRel}: contact_links[${i}] needs non-empty name, url and about`);
        } else if (!/^https:\/\//.test(String(link.url))) {
          errors.push(`${configRel}: contact_links[${i}] url must be https`);
        }
      }
      const security = links.some((l) => isRecord(l) && typeof l.url === "string" && /\/security\/advisories\/new$/.test(l.url));
      if (!security) errors.push(`${configRel}: needs a contact link to private vulnerability reporting (/security/advisories/new)`);
    }
  }
}

/**
 * Extracts the `- [ ]` items of the Definition of Done in CONTEXT_PACK §10.
 * @param {string} pack
 * @returns {string[]}
 */
export function packDodItems(pack) {
  const lines = pack.split("\n");
  const start = lines.findIndex((l) => /^###\s+Definition of Done/.test(l));
  if (start === -1) return [];
  /** @type {string[]} */
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line)) break;
    const match = /^- \[ \] (.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) items.push(match[1]);
  }
  return items;
}

/**
 * Splits Markdown into level-2 sections, ignoring HTML comments.
 * @param {string} markdown
 * @returns {Array<{ heading: string, body: string }>}
 */
function sections(markdown) {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, "");
  /** @type {Array<{ heading: string, body: string }>} */
  const out = [];
  for (const line of text.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) out.push({ heading: match[1], body: "" });
    else if (out.length > 0) {
      const last = out[out.length - 1];
      if (last !== undefined) last.body += `${line}\n`;
    }
  }
  return out;
}

/**
 * @param {string} root
 * @param {string[]} errors
 */
function checkPrTemplate(root, errors) {
  const file = path.join(root, PR_TEMPLATE);
  if (!existsSync(file)) {
    errors.push(`${PR_TEMPLATE}: missing`);
    return;
  }
  const parts = sections(readFileSync(file, "utf8"));
  const headings = parts.map((p) => p.heading);
  if (headings.join("|") !== PR_SECTIONS.join("|")) {
    errors.push(`${PR_TEMPLATE}: sections must be exactly [${PR_SECTIONS.join(", ")}] in order, found [${headings.join(", ")}]`);
  }
  /** @param {string} heading */
  const body = (heading) => parts.find((p) => p.heading === heading)?.body ?? "";
  if (!/^Closes #\s*$/m.test(body("Linked issue"))) errors.push(`${PR_TEMPLATE}: "Linked issue" must prompt with a "Closes #" line`);
  if (!/^- \[ \] /m.test(body("Acceptance criteria"))) errors.push(`${PR_TEMPLATE}: "Acceptance criteria" needs a "- [ ]" checklist`);
  if (!/§8/.test(readFileSync(file, "utf8"))) errors.push(`${PR_TEMPLATE}: "Security considerations" must reference CONTEXT_PACK §8`);

  const packFile = path.join(root, CONTEXT_PACK);
  if (!existsSync(packFile)) {
    errors.push(`${CONTEXT_PACK}: missing`);
    return;
  }
  const expected = packDodItems(readFileSync(packFile, "utf8"));
  if (expected.length === 0) {
    errors.push(`${CONTEXT_PACK}: no "### Definition of Done" checklist found`);
    return;
  }
  const actual = [...body("Definition of Done").matchAll(/^- \[ \] (.+?)\s*$/gm)].map((m) => m[1] ?? "");
  for (const item of expected) {
    if (!actual.includes(item)) errors.push(`${PR_TEMPLATE}: Definition of Done is missing the §10 item "${item}"`);
  }
  for (const item of actual) {
    if (!expected.includes(item)) errors.push(`${PR_TEMPLATE}: Definition of Done item "${item}" is not in CONTEXT_PACK §10`);
  }
}

/**
 * @typedef {{ line: number, pattern: string, owners: string[] }} OwnerRule
 */

/**
 * Parses CODEOWNERS and reports syntax GitHub does not support.
 * @param {string} text
 * @param {string[]} errors
 * @returns {OwnerRule[]}
 */
export function parseCodeowners(text, errors) {
  /** @type {OwnerRule[]} */
  const rules = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `${CODEOWNERS}:${i + 1}`;
    const [pattern = "", ...rest] = line.split(/\s+/);
    const commentAt = rest.findIndex((t) => t.startsWith("#"));
    const owners = commentAt === -1 ? rest : rest.slice(0, commentAt);
    if (pattern.startsWith("!")) errors.push(`${where}: "!" negation is not supported by GitHub CODEOWNERS`);
    if (/[[\]]/.test(pattern)) errors.push(`${where}: "[ ]" character ranges are not supported by GitHub CODEOWNERS`);
    if (pattern.includes("\\")) errors.push(`${where}: backslash escapes are not supported by GitHub CODEOWNERS`);
    if (owners.length === 0) errors.push(`${where}: "${pattern}" has no owners`);
    for (const owner of owners) {
      if (!OWNER.test(owner)) errors.push(`${where}: "${owner}" is not a valid owner (@user, @org/team or an email)`);
    }
    rules.push({ line: i + 1, pattern, owners });
  });
  return rules;
}

/**
 * Converts a CODEOWNERS (gitignore-style) pattern to a RegExp over repository-relative paths.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function patternToRegExp(pattern) {
  let p = pattern;
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  if (p.endsWith("/")) p = p.slice(0, -1);
  let re = "";
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i] ?? "";
    if (ch === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${re}(?:/.*)?$`);
}

/**
 * Owners of a file under GitHub's rule that the last matching pattern wins.
 * @param {OwnerRule[]} rules
 * @param {string} file
 * @returns {string[]}
 */
export function ownersOf(rules, file) {
  let owners = /** @type {string[]} */ ([]);
  for (const rule of rules) {
    if (patternToRegExp(rule.pattern).test(file)) owners = rule.owners;
  }
  return owners;
}

/**
 * Reads the owner registry table: | `@owner` | placeholder|active | ... |
 * @param {string} markdown
 * @returns {Map<string, "placeholder" | "active">}
 */
export function parseOwnerRegistry(markdown) {
  /** @type {Map<string, "placeholder" | "active">} */
  const registry = new Map();
  for (const match of markdown.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(placeholder|active)\s*\|/gm)) {
    if (match[1] !== undefined && (match[2] === "placeholder" || match[2] === "active")) registry.set(match[1].toLowerCase(), match[2]);
  }
  return registry;
}

/**
 * @param {string} root
 * @param {string[]} errors
 */
function checkCodeowners(root, errors) {
  const file = path.join(root, CODEOWNERS);
  if (!existsSync(file)) {
    errors.push(`${CODEOWNERS}: missing`);
    return;
  }
  const text = readFileSync(file, "utf8");
  if (Buffer.byteLength(text) >= 3 * 1024 * 1024) errors.push(`${CODEOWNERS}: must be smaller than 3 MB (GitHub ignores larger files)`);
  const rules = parseCodeowners(text, errors);

  const registryFile = path.join(root, OWNER_REGISTRY);
  if (!existsSync(registryFile)) {
    errors.push(`${OWNER_REGISTRY}: missing (the code-owner registry)`);
    return;
  }
  const registry = parseOwnerRegistry(readFileSync(registryFile, "utf8"));
  const named = new Set(rules.flatMap((r) => r.owners));
  for (const owner of named) {
    if (!registry.has(owner.toLowerCase())) {
      errors.push(`${CODEOWNERS}: owner "${owner}" is not listed in the ${OWNER_REGISTRY} registry (unknown owners are ignored by GitHub)`);
    }
  }
  const placeholders = [...named].filter((o) => registry.get(o.toLowerCase()) === "placeholder");
  if (placeholders.length > 0 && !/OFFLINE-STUB\(online-porting #\d+\)/.test(text)) {
    errors.push(`${CODEOWNERS}: names placeholder owners (${placeholders.join(", ")}) but has no OFFLINE-STUB(online-porting #N) marker`);
  }
  if (!rules.some((r) => r.pattern === "*")) errors.push(`${CODEOWNERS}: needs a default "*" rule`);
  for (const sample of SECURITY_OWNED_SAMPLES) {
    const owners = ownersOf(rules, sample);
    if (!owners.includes(SECURITY_OWNERS)) {
      errors.push(`${CODEOWNERS}: "${sample}" must be owned by ${SECURITY_OWNERS} (last match gives [${owners.join(", ")}])`);
    }
  }
}

/**
 * Runs every check against `root`.
 * @param {string} root
 * @returns {{ ok: boolean, root: string, errors: string[] }}
 */
export function checkGithub(root) {
  /** @type {string[]} */
  const errors = [];
  const { manifest, errors: manifestErrors } = loadManifest(path.join(root, MANIFEST_PATH));
  for (const e of manifestErrors) errors.push(`${MANIFEST_PATH}: ${e}`);
  const labelNames = new Set((manifest?.labels ?? []).map((l) => l.name.toLowerCase()));
  checkIssueTemplates(root, labelNames, manifest, errors);
  checkPrTemplate(root, errors);
  checkCodeowners(root, errors);
  return { ok: errors.length === 0, root, errors };
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, quiet: boolean }}
 */
function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") quiet = true;
    else if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root requires a directory argument");
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
    process.stderr.write(`check-github: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const result = checkGithub(args.root);
  if (!args.quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(
      `check-github: ${result.errors.length} problem(s) found:\n` + result.errors.map((e) => `  - ${e}`).join("\n") + "\n",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
