#!/usr/bin/env node
// Architectural import and dependency boundaries (FOUND-005, #7).
//
// One model (ELEMENT_TYPES and the special rules below) is the single source of truth for:
//   - the dependency-cruiser rule set that checks every import edge between workspace members
//     (type-only imports included: they are erased at build time but still couple the code);
//   - the checks on declared workspace dependencies in each member's package.json;
//   - the generated docs/architecture/dependency-graph.md (the check fails when it is stale).
//
// Violations are grouped by kind. Circular dependencies (between packages, or between modules
// inside one package) are reported separately from boundary violations.
//
// Usage:
//   node scripts/check-boundaries.mjs [--root <dir>] [--json <file|->] [--write-docs] [--quiet]
//
//   --json <file>   also write the machine-readable report (for CI annotation); "-" = stdout
//   --write-docs    regenerate docs/architecture/dependency-graph.md, then check
//   --quiet         print nothing when the check passes
//
// Exit codes: 0 clean, 1 violations or cycles found, 2 usage or internal error.
// When GITHUB_ACTIONS=true each problem is also printed as a workflow `::error` annotation.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cruise } from 'dependency-cruiser';

import { parseWorkspaceGlobs } from './check-layout.mjs';

/**
 * @typedef {object} ElementType
 * @property {string} name      element type name, used in rule names (`<from>-not-to-<to>`)
 * @property {string} summary   one-line description for the generated documentation
 * @property {readonly string[]} members  workspace member directories of this type
 * @property {readonly string[]} mayImport  element types this type may depend on
 */

/**
 * The allowed dependency DAG between element types. Every workspace member must belong to
 * exactly one type; an unclassified member fails the check (fail closed).
 *
 * Within `shared-lib` and `service-lib` members may depend on each other, but never in a cycle.
 * @type {readonly ElementType[]}
 */
export const ELEMENT_TYPES = Object.freeze([
  {
    name: 'contracts',
    summary: 'Zod schemas shared by every layer (CONTEXT_PACK §5). The root of the graph.',
    members: ['packages/contracts'],
    mayImport: [],
  },
  {
    name: 'shared-lib',
    summary:
      'Cross-cutting foundation libraries: config, errors, ids, logging, time, telemetry, crypto primitives, test helpers.',
    members: [
      'packages/config',
      'packages/crypto',
      'packages/errors',
      'packages/ids',
      'packages/logger',
      'packages/telemetry',
      'packages/testing',
      'packages/time',
      'packages/workflow-shared',
    ],
    mayImport: ['contracts', 'shared-lib'],
  },
  {
    name: 'domain',
    summary: 'Pure domain logic: run state machine, finding lifecycle, dedup and fingerprinting.',
    members: ['packages/domain'],
    mayImport: ['contracts', 'shared-lib'],
  },
  {
    name: 'policy',
    summary:
      'Deterministic policy decision point (Cedar). Kept free of app and service coupling (CONTEXT_PACK §8.11).',
    members: ['packages/policy'],
    mayImport: ['contracts', 'shared-lib'],
  },
  {
    name: 'service-lib',
    summary: 'Platform, data-access and integration libraries used by the apps.',
    members: [
      'packages/agents',
      'packages/api-client',
      'packages/audit',
      'packages/connectors',
      'packages/cost',
      'packages/db',
      'packages/events',
      'packages/evidence',
      'packages/mcp-tools',
      'packages/memory',
      'packages/notify',
      'packages/oob',
      'packages/replay',
      'packages/reporting',
      'packages/secrets',
      'packages/ui',
    ],
    mayImport: ['contracts', 'shared-lib', 'domain', 'policy', 'service-lib'],
  },
  {
    name: 'app',
    summary: 'TypeScript deployables. They compose packages and never reach into another app.',
    members: [
      'apps/agent-runtime',
      'apps/api',
      'apps/cli',
      'apps/model-gateway',
      'apps/sandbox-controller',
      'apps/session-manager',
      'apps/web',
      'apps/worker',
    ],
    mayImport: ['contracts', 'shared-lib', 'domain', 'policy', 'service-lib'],
  },
  {
    name: 'go-service',
    summary:
      'The Go egress gateway. Its TypeScript stub imports nothing internal; its Go module stays self-contained.',
    members: ['apps/egress-gateway'],
    mayImport: [],
  },
]);

/** The test-helper package. Any test code may import it; production code never does. */
export const TESTING_MEMBER = 'packages/testing';

/** Code that runs inside agent sandboxes (CONTEXT_PACK §4.1). */
export const SANDBOX_MEMBERS = Object.freeze(['apps/agent-runtime', 'packages/mcp-tools']);

/**
 * Packages that hold server-side credentials or direct data-store access. Sandboxes reach only
 * the egress gateway, the model gateway and the Run Broker API, and secrets never reach a
 * sandbox in plaintext (CONTEXT_PACK §4.1, §8.6, §8.7), so sandbox code must not reach these,
 * directly or through another package.
 */
export const SERVER_ONLY_MEMBERS = Object.freeze([
  'packages/audit',
  'packages/connectors',
  'packages/db',
  'packages/notify',
  'packages/secrets',
]);

/**
 * The owner-role database entry point (`@blackwing/db/owner`, DB-001). Migrations run as the owner
 * role and runtime apps must never load its credentials (CONTEXT_PACK §7, §8.6), so only
 * `packages/db` itself, test code and the members listed in DB_OWNER_IMPORTERS may import it.
 */
export const DB_OWNER_ENTRY = 'packages/db/src/owner.ts';

/** Members allowed to import DB_OWNER_ENTRY besides packages/db (the migrate job, DB-002). */
/** @type {readonly string[]} */
export const DB_OWNER_IMPORTERS = Object.freeze([]);

/**
 * Test code: may additionally import @blackwing/testing. Matched against repository-relative
 * paths.
 */
export const TEST_CODE_PATTERN =
  '(^|/)(test|tests|__tests__|__fixtures__|e2e|testdata|typefixtures)/|\\.(test|spec)\\.[cm]?[jt]sx?$|(^|/)(vitest|playwright)(\\.int)?\\.config\\.[cm]?[jt]s$';

const TEST_CODE = new RegExp(TEST_CODE_PATTERN);

/** The generated documentation file, relative to the repository root. */
export const DOC_FILE = 'docs/architecture/dependency-graph.md';

/** An import specifier that reaches into another package's source tree. */
const DEEP_SRC_SPECIFIER = /^@blackwing\/[^/]+\/src(?:\/|$)/;

/** Source files scanned in every member. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Directories never scanned: dependencies, build output and caches. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  'storybook-static',
]);

/** package.json dependency fields that hold workspace edges. */
const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/** Violation kinds, in report order. */
export const VIOLATION_KINDS = Object.freeze([
  'unclassified',
  'boundary',
  'test-only',
  'server-only',
  'deep-import',
  'unresolvable',
  'go',
  'docs',
]);

/**
 * @typedef {object} Member
 * @property {string} dir       e.g. "packages/config"
 * @property {string} name      package name, e.g. "@blackwing/config"
 * @property {string | null} type  element type, or null when unclassified
 * @property {string[]} entries  regular expressions matching the member's public entry files
 * @property {Record<string, unknown>} manifest  parsed package.json
 */

/**
 * @typedef {object} Violation
 * @property {string} kind      one of VIOLATION_KINDS
 * @property {string} rule      the rule that was broken
 * @property {string} from      repository-relative file (or package.json / go.mod)
 * @property {string} to        resolved target file, or the import specifier when unresolved
 * @property {string | null} specifier  the import specifier as written (null for non-import checks)
 * @property {string | null} fromMember
 * @property {string | null} fromType
 * @property {string | null} toMember
 * @property {string | null} toType
 * @property {string[]} via     intermediate modules of a transitive violation
 * @property {string} message   human-readable explanation naming the offending edge
 */

/**
 * @typedef {object} Cycle
 * @property {'package-cycle' | 'module-cycle'} kind
 * @property {string} rule
 * @property {string[]} path    the cycle, first element repeated at the end
 * @property {string} message
 */

/**
 * @typedef {object} BoundaryReport
 * @property {boolean} ok
 * @property {string} root
 * @property {{ members: number, modules: number, dependencies: number, violations: number, cycles: number }} summary
 * @property {Violation[]} violations
 * @property {Cycle[]} cycles
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRe(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** @type {ReadonlyMap<string, ElementType>} */
const TYPE_BY_NAME = new Map(ELEMENT_TYPES.map((t) => [t.name, t]));

/**
 * Element type of a member directory according to the model.
 * @param {string} dir
 * @returns {string | null}
 */
export function classifyMember(dir) {
  for (const type of ELEMENT_TYPES) if (type.members.includes(dir)) return type.name;
  return null;
}

/**
 * Whether code of element type `from` may depend on element type `to`.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isAllowedEdge(from, to) {
  return TYPE_BY_NAME.get(from)?.mayImport.includes(to) ?? false;
}

/**
 * @param {string} file  repository-relative path
 * @returns {boolean}
 */
export function isTestCode(file) {
  return TEST_CODE.test(file);
}

/**
 * Collects the string targets of a package.json `exports` value (any nesting of conditions).
 * @param {unknown} value
 * @param {string[]} out
 */
function exportTargets(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) exportTargets(v, out);
  else if (isObject(value)) for (const v of Object.values(value)) exportTargets(v, out);
}

/**
 * Regular expressions matching a member's public entry files: the targets of its `exports`
 * map, or `main`/`types` when it has none.
 * @param {string} dir
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function entryPatterns(dir, manifest) {
  /** @type {string[]} */
  const targets = [];
  if (manifest.exports === undefined) {
    for (const field of ['main', 'module', 'types']) {
      const v = manifest[field];
      if (typeof v === 'string') targets.push(v);
    }
  } else {
    exportTargets(manifest.exports, targets);
  }
  return [...new Set(targets)].map((target) => {
    const rel = path.posix.normalize(target.replace(/^\.\//, ''));
    return `^${escapeRe(`${dir}/${rel}`).replaceAll(String.raw`\*`, '.+')}$`;
  });
}

/**
 * Lists the pnpm workspace members (directories with a package.json) under the root.
 * @param {string} root
 * @returns {Member[]}
 */
export function loadMembers(root) {
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  const globs = existsSync(workspaceFile)
    ? (parseWorkspaceGlobs(readFileSync(workspaceFile, 'utf8')) ?? [])
    : [];
  /** @type {Member[]} */
  const members = [];
  for (const glob of globs) {
    const match = /^([\w.-]+)\/\*$/.exec(glob);
    if (!match?.[1]) continue;
    const group = match[1];
    const groupDir = path.join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${group}/${entry.name}`;
      const manifestFile = path.join(root, dir, 'package.json');
      if (!existsSync(manifestFile)) continue;
      /** @type {unknown} */
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const manifest = isObject(parsed) ? parsed : {};
      const name = typeof manifest.name === 'string' ? manifest.name : `@blackwing/${entry.name}`;
      members.push({
        dir,
        name,
        type: classifyMember(dir),
        entries: entryPatterns(dir, manifest),
        manifest,
      });
    }
  }
  return members.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Regular expressions matching a set of members both as resolved paths and as unresolved
 * package specifiers (an undeclared workspace dependency cannot be resolved through pnpm's
 * symlinks, but the edge must still be named).
 * @param {Member[]} members
 * @returns {string[]}
 */
function targetPatterns(members) {
  if (members.length === 0) return [];
  return [
    `^(?:${members.map((m) => escapeRe(m.dir)).join('|')})/`,
    `^(?:${members.map((m) => escapeRe(m.name)).join('|')})(?:/|$)`,
  ];
}

/**
 * @param {Member[]} members
 * @returns {string}
 */
function fromPattern(members) {
  return `^(${members.map((m) => escapeRe(m.dir)).join('|')})/`;
}

/**
 * Builds the dependency-cruiser rule set from the model for the given workspace members.
 * @param {Member[]} members
 * @returns {import('dependency-cruiser').IForbiddenRuleType[]}
 */
export function buildRules(members) {
  /** @type {import('dependency-cruiser').IForbiddenRuleType[]} */
  const rules = [];
  const ofType = (/** @type {string} */ type) => members.filter((m) => m.type === type);

  for (const from of ELEMENT_TYPES) {
    const sources = ofType(from.name);
    if (sources.length === 0) continue;
    for (const to of ELEMENT_TYPES) {
      if (from.mayImport.includes(to.name)) continue;
      // Test code may import @blackwing/testing; production code is covered by the
      // testing-only-from-tests rule below.
      const targets = ofType(to.name).filter((m) => m.dir !== TESTING_MEMBER);
      if (targets.length === 0) continue;
      rules.push({
        name: `${from.name}-not-to-${to.name}`,
        severity: 'error',
        comment: `${from.name} may import ${describeAllowed(from)}; not ${to.name}.`,
        from: { path: fromPattern(sources) },
        to: { path: targetPatterns(targets), pathNot: '^$1/' },
      });
    }
  }

  const testing = members.filter((m) => m.dir === TESTING_MEMBER);
  if (testing.length > 0) {
    rules.push({
      name: 'testing-only-from-tests',
      severity: 'error',
      comment: '@blackwing/testing holds test fixtures; only test code may import it.',
      from: { pathNot: [TEST_CODE_PATTERN, `^${escapeRe(TESTING_MEMBER)}/`] },
      to: { path: targetPatterns(testing) },
    });
  }

  const sandbox = members.filter((m) => SANDBOX_MEMBERS.includes(m.dir));
  const serverOnly = members.filter((m) => SERVER_ONLY_MEMBERS.includes(m.dir));
  if (sandbox.length > 0 && serverOnly.length > 0) {
    rules.push({
      name: 'sandbox-not-to-server-only',
      severity: 'error',
      comment:
        'Sandbox code must not reach server-only packages, directly or transitively (CONTEXT_PACK §4.1, §8.6, §8.7).',
      from: { path: fromPattern(sandbox), pathNot: TEST_CODE_PATTERN },
      to: { path: targetPatterns(serverOnly), reachable: true },
    });
  }

  if (members.some((m) => m.dir === 'packages/db')) {
    rules.push({
      name: 'db-owner-only-from-migrate',
      severity: 'error',
      comment:
        'Only the migrate job may import @blackwing/db/owner: runtime code uses the app-role pool and never loads owner credentials (CONTEXT_PACK §7, §8.6).',
      from: {
        pathNot: [
          TEST_CODE_PATTERN,
          ...['packages/db', ...DB_OWNER_IMPORTERS].map((dir) => `^${escapeRe(dir)}/`),
        ],
      },
      to: { path: `^${escapeRe(DB_OWNER_ENTRY)}$` },
    });
  }

  rules.push(
    {
      name: 'no-deep-import',
      severity: 'error',
      comment:
        'Import another member only through its public entry point (its package.json exports).',
      from: { path: '^((?:apps|packages)/[^/]+)/' },
      to: {
        path: '^(?:apps|packages)/[^/]+/',
        pathNot: ['^$1/', ...members.flatMap((m) => m.entries)],
      },
    },
    {
      name: 'no-deep-import-specifier',
      severity: 'error',
      comment: 'Import @blackwing/<x>, never a subpath such as @blackwing/<x>/src/...',
      from: {},
      to: { couldNotResolve: true, path: '^@blackwing/[^/]+/.+' },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'Every import must resolve (through pnpm workspace symlinks for @blackwing/* packages): declare the dependency in package.json.',
      from: {},
      to: { couldNotResolve: true, pathNot: '^@blackwing/[^/]+/.+' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Modules must not depend on each other in a cycle.',
      from: {},
      to: { circular: true },
    },
  );
  return rules;
}

/**
 * @param {ElementType} type
 * @returns {string}
 */
function describeAllowed(type) {
  return type.mayImport.length === 0 ? 'nothing internal' : type.mayImport.join(', ');
}

/**
 * Lists the source files of every member, repository-relative.
 * @param {string} root
 * @param {Member[]} members
 * @returns {string[]}
 */
function listSourceFiles(root, members) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(child);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        files.push(child);
      }
    }
  };
  for (const member of members) walk(member.dir);
  return files.sort();
}

/**
 * Finds the member a repository-relative path or package specifier belongs to.
 * @param {string} target
 * @param {Member[]} members
 * @returns {Member | null}
 */
function memberOf(target, members) {
  for (const m of members) {
    if (target.startsWith(`${m.dir}/`) || target === m.name || target.startsWith(`${m.name}/`)) {
      return m;
    }
  }
  return null;
}

/** @type {Readonly<Record<string, string>>} */
const KIND_BY_RULE = Object.freeze({
  'testing-only-from-tests': 'test-only',
  'sandbox-not-to-server-only': 'server-only',
  'db-owner-only-from-migrate': 'server-only',
  'no-deep-import': 'deep-import',
  'no-deep-import-specifier': 'deep-import',
  'no-unresolvable': 'unresolvable',
});

/**
 * @param {Partial<Violation> & Pick<Violation, 'kind' | 'rule' | 'from' | 'to' | 'message'>} v
 * @param {Member[]} members
 * @returns {Violation}
 */
function violation(v, members) {
  const fromMember = v.fromMember ?? memberOf(v.from, members)?.dir ?? null;
  const toMember = v.toMember ?? memberOf(v.to, members)?.dir ?? null;
  return {
    kind: v.kind,
    rule: v.rule,
    from: v.from,
    to: v.to,
    specifier: v.specifier ?? null,
    fromMember,
    fromType: fromMember === null ? null : classifyMember(fromMember),
    toMember,
    toType: toMember === null ? null : classifyMember(toMember),
    via: v.via ?? [],
    message: v.message,
  };
}

/**
 * Explains a dependency-cruiser violation in terms of the model.
 * @param {string} rule
 * @param {string} from
 * @param {string} to
 * @param {string[]} via
 * @param {Member[]} members
 * @returns {string}
 */
function explain(rule, from, to, via, members) {
  const fm = memberOf(from, members);
  const tm = memberOf(to, members);
  const edge = `${from} -> ${via.length > 0 ? `${via.join(' -> ')} -> ` : ''}${to}`;
  const boundary = /^(.+)-not-to-(.+)$/.exec(rule);
  if (boundary && fm && tm && rule !== 'sandbox-not-to-server-only') {
    const fromType = TYPE_BY_NAME.get(boundary[1] ?? '');
    return `${boundary[1] ?? ''} ${fm.dir} may not depend on ${boundary[2] ?? ''} ${tm.dir} (${boundary[1] ?? ''} may import ${fromType ? describeAllowed(fromType) : '?'}): ${edge}`;
  }
  switch (rule) {
    case 'testing-only-from-tests':
      return `production code may not import @blackwing/testing (only test code may): ${edge}`;
    case 'sandbox-not-to-server-only':
      return `sandbox code ${fm?.dir ?? from} may not reach server-only ${tm?.dir ?? to}: ${edge}`;
    case 'no-deep-import':
    case 'no-deep-import-specifier':
      return `deep import into ${tm?.name ?? to}; import its public entry point instead: ${edge}`;
    case 'no-unresolvable':
      return `cannot resolve ${to} (undeclared workspace dependency or missing package): ${edge}`;
    default:
      return `${rule}: ${edge}`;
  }
}

/**
 * Finds the strongly connected components of a directed graph (Tarjan) and returns one
 * concrete cycle per component with more than one node.
 * @param {Map<string, Set<string>>} graph
 * @returns {string[][]}
 */
export function findCycles(graph) {
  let index = 0;
  /** @type {Map<string, number>} */
  const indices = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  /** @type {string[]} */
  const stack = [];
  const onStack = new Set();
  /** @type {string[][]} */
  const components = [];

  /** @param {string} v */
  const connect = (v) => {
    indices.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of [...(graph.get(v) ?? [])].sort()) {
      if (!indices.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, indices.get(w) ?? 0));
      }
    }
    if (low.get(v) === indices.get(v)) {
      /** @type {string[]} */
      const component = [];
      let w;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!indices.has(v)) connect(v);

  return components
    .map((component) => {
      const inside = new Set(component);
      const start = component[0] ?? '';
      // Breadth-first search for the shortest path back to the start inside the component.
      /** @type {Map<string, string>} */
      const parent = new Map();
      /** @type {string[]} */
      const queue = [start];
      /** @type {string | null} */
      let last = null;
      while (queue.length > 0 && last === null) {
        const v = queue.shift() ?? '';
        for (const w of [...(graph.get(v) ?? [])].sort()) {
          if (!inside.has(w)) continue;
          if (w === start) {
            last = v;
            break;
          }
          if (!parent.has(w)) {
            parent.set(w, v);
            queue.push(w);
          }
        }
      }
      /** @type {string[]} */
      const cycle = [start];
      for (let v = last; v !== null && v !== start; v = parent.get(v) ?? null)
        cycle.splice(1, 0, v);
      cycle.push(start);
      return cycle;
    })
    .sort((a, b) => a.join().localeCompare(b.join()));
}

/**
 * Checks the declared workspace dependencies in every member's package.json.
 * @param {Member[]} members
 * @returns {{ violations: Violation[], edges: Array<[string, string]> }}
 */
export function checkManifests(members) {
  /** @type {Violation[]} */
  const violations = [];
  /** @type {Array<[string, string]>} */
  const edges = [];
  const byName = new Map(members.map((m) => [m.name, m]));
  for (const member of members) {
    const manifestPath = `${member.dir}/package.json`;
    for (const field of DEPENDENCY_FIELDS) {
      const deps = member.manifest[field];
      if (!isObject(deps)) continue;
      for (const dep of Object.keys(deps).sort()) {
        if (!dep.startsWith('@blackwing/')) continue;
        const target = byName.get(dep);
        if (!target) {
          violations.push(
            violation(
              {
                kind: 'unresolvable',
                rule: 'manifest-unknown-workspace-package',
                from: manifestPath,
                to: dep,
                fromMember: member.dir,
                message: `${manifestPath} declares ${dep} in ${field}, which is not a workspace member`,
              },
              members,
            ),
          );
          continue;
        }
        if (target.dir === member.dir) continue;
        edges.push([member.dir, target.dir]);
        if (member.type === null || target.type === null) continue;
        if (target.dir === TESTING_MEMBER) {
          if (field !== 'devDependencies' && member.dir !== TESTING_MEMBER) {
            violations.push(
              violation(
                {
                  kind: 'test-only',
                  rule: 'manifest-testing-only-dev',
                  from: manifestPath,
                  to: dep,
                  message: `${manifestPath} declares ${dep} in ${field}; @blackwing/testing is test-only and belongs in devDependencies`,
                },
                members,
              ),
            );
          }
          continue;
        }
        if (!isAllowedEdge(member.type, target.type)) {
          const fromType = TYPE_BY_NAME.get(member.type);
          violations.push(
            violation(
              {
                kind: 'boundary',
                rule: `${member.type}-not-to-${target.type}`,
                from: manifestPath,
                to: dep,
                message: `${member.type} ${member.dir} may not depend on ${target.type} ${target.dir} (${member.type} may import ${fromType ? describeAllowed(fromType) : '?'}): ${manifestPath} declares ${dep} in ${field}`,
              },
              members,
            ),
          );
        }
      }
    }
    const exportsField = member.manifest.exports;
    if (isObject(exportsField)) {
      for (const key of Object.keys(exportsField)) {
        if (/^\.\/src(?:\/|$)/.test(key)) {
          violations.push(
            violation(
              {
                kind: 'deep-import',
                rule: 'manifest-no-src-subpath-export',
                from: manifestPath,
                to: `${member.name}/${key.slice(2)}`,
                fromMember: member.dir,
                toMember: member.dir,
                message: `${manifestPath} exports the subpath "${key}"; expose a public entry point, not the source tree`,
              },
              members,
            ),
          );
        }
      }
    }
  }
  return { violations, edges };
}

/**
 * Go services: the module must stay self-contained (no local `replace` pointing outside it, no
 * imports of other paths in this repository's module namespace).
 * @param {string} root
 * @param {Member[]} members
 * @returns {Violation[]}
 */
export function checkGoServices(root, members) {
  /** @type {Violation[]} */
  const violations = [];
  for (const member of members.filter((m) => m.type === 'go-service')) {
    const goModFile = path.join(root, member.dir, 'go.mod');
    if (!existsSync(goModFile)) continue;
    const goMod = readFileSync(goModFile, 'utf8');
    const goModRel = `${member.dir}/go.mod`;
    const modulePath = /^module\s+(\S+)/m.exec(goMod)?.[1] ?? '';

    const replaceLines = [];
    for (const m of goMod.matchAll(/^replace\s+\(([\s\S]*?)^\)/gm)) {
      replaceLines.push(...(m[1] ?? '').split('\n'));
    }
    for (const m of goMod.matchAll(/^replace\s+([^(\n].*)$/gm)) replaceLines.push(m[1] ?? '');
    for (const line of replaceLines) {
      const target = /=>\s*(\S+)/.exec(line.replace(/\/\/.*$/, ''))?.[1];
      if (target === undefined || !/^(\.{1,2}\/|\/)/.test(target)) continue;
      const resolved = path.relative(
        path.join(root, member.dir),
        path.resolve(root, member.dir, target),
      );
      if (resolved.startsWith('..') || path.isAbsolute(resolved)) {
        violations.push(
          violation(
            {
              kind: 'go',
              rule: 'go-no-replace-outside-module',
              from: goModRel,
              to: target,
              fromMember: member.dir,
              message: `${goModRel} replaces a module with ${target}, outside ${member.dir}; the Go service must stay self-contained`,
            },
            members,
          ),
        );
      }
    }

    const suffix = `/${member.dir}`;
    if (!modulePath.endsWith(suffix)) continue;
    const repoPrefix = modulePath.slice(0, -member.dir.length);
    /** @param {string} rel */
    const walk = (rel) => {
      for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'vendor' && !SKIPPED_DIRS.has(entry.name)) walk(child);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.go')) continue;
        const source = readFileSync(path.join(root, child), 'utf8');
        /** @type {string[]} */
        const imports = [];
        for (const block of source.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
          for (const spec of (block[1] ?? '').matchAll(/"([^"]+)"/g)) imports.push(spec[1] ?? '');
        }
        for (const single of source.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) {
          imports.push(single[1] ?? '');
        }
        for (const spec of imports) {
          if (
            spec.startsWith(repoPrefix) &&
            spec !== modulePath &&
            !spec.startsWith(`${modulePath}/`)
          ) {
            violations.push(
              violation(
                {
                  kind: 'go',
                  rule: 'go-no-import-outside-module',
                  from: child,
                  to: spec,
                  fromMember: member.dir,
                  message: `${child} imports ${spec}, outside the ${modulePath} module`,
                },
                members,
              ),
            );
          }
        }
      }
    };
    walk(member.dir);
  }
  return violations;
}

/**
 * Runs the full boundary check on a workspace.
 * @param {string} root
 * @param {{ docs?: boolean }} [options]  docs: also verify the generated documentation (default true)
 * @returns {Promise<BoundaryReport>}
 */
export async function checkBoundaries(root, options = {}) {
  const members = loadMembers(root);
  /** @type {Violation[]} */
  const violations = [];
  /** @type {Cycle[]} */
  const cycles = [];

  for (const m of members.filter((x) => x.type === null)) {
    violations.push(
      violation(
        {
          kind: 'unclassified',
          rule: 'member-unclassified',
          from: `${m.dir}/package.json`,
          to: m.dir,
          fromMember: m.dir,
          toMember: m.dir,
          message: `${m.dir} (${m.name}) has no element type; add it to ELEMENT_TYPES in scripts/check-boundaries.mjs and regenerate ${DOC_FILE}`,
        },
        members,
      ),
    );
  }

  const files = listSourceFiles(root, members);
  let modules = 0;
  let dependencies = 0;
  /** @type {Map<string, Set<string>>} */
  const packageGraph = new Map(members.map((m) => [m.dir, new Set()]));

  if (files.length > 0) {
    const result = await cruise(
      files,
      {
        baseDir: root,
        validate: true,
        ruleSet: { forbidden: buildRules(members) },
        tsPreCompilationDeps: true,
        detectJSDocImports: true,
        doNotFollow: { path: ['(^|/)node_modules/'] },
        exclude: { path: ['(^|/)node_modules/'] },
        enhancedResolveOptions: {
          exportsFields: ['exports'],
          conditionNames: ['types', 'import', 'node', 'default'],
          mainFields: ['types', 'module', 'main'],
        },
      },
      { bustTheCache: true },
    );
    const output = result.output;
    if (typeof output === 'string') throw new TypeError('dependency-cruiser returned text output');
    modules = output.summary.totalCruised;
    dependencies = output.summary.totalDependenciesCruised ?? 0;

    for (const mod of output.modules) {
      const from = memberOf(mod.source, members);
      if (!from) continue;
      for (const dep of mod.dependencies) {
        const to = memberOf(dep.couldNotResolve ? dep.module : dep.resolved, members);
        if (to && to.dir !== from.dir) packageGraph.get(from.dir)?.add(to.dir);
        // A `@blackwing/<x>/src/...` specifier is a deep import even when an exports map makes
        // it resolvable (the unresolvable case is a dependency-cruiser rule).
        if (!dep.couldNotResolve && DEEP_SRC_SPECIFIER.test(dep.module)) {
          violations.push(
            violation(
              {
                kind: 'deep-import',
                rule: 'no-deep-import-specifier',
                from: mod.source,
                to: dep.resolved,
                specifier: dep.module,
                message: explain('no-deep-import-specifier', mod.source, dep.module, [], members),
              },
              members,
            ),
          );
        }
      }
    }

    const seen = new Set();
    for (const v of output.summary.violations) {
      const rule = v.rule.name;
      if (rule === 'no-circular') {
        const cyclePath = [v.from, ...(v.cycle ?? []).map((c) => c.name)];
        const owners = new Set(cyclePath.map((p) => memberOf(p, members)?.dir ?? p));
        // Cycles that cross members are reported once, as a package cycle.
        if (owners.size > 1) continue;
        const key = [...cyclePath].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        cycles.push({
          kind: 'module-cycle',
          rule,
          path: cyclePath,
          message: `module cycle in ${[...owners][0] ?? '?'}: ${cyclePath.join(' -> ')}`,
        });
        continue;
      }
      const to = v.to;
      const via = (v.via ?? []).map((d) => d.name).filter((n) => n !== to);
      const key = `${rule}|${v.from}|${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(
        violation(
          {
            kind: KIND_BY_RULE[rule] ?? 'boundary',
            rule,
            from: v.from,
            to,
            specifier: v.unresolvedTo ?? null,
            via,
            message: explain(rule, v.from, to, via, members),
          },
          members,
        ),
      );
    }
  }

  const manifests = checkManifests(members);
  violations.push(...manifests.violations);
  for (const [from, to] of manifests.edges) packageGraph.get(from)?.add(to);

  for (const cyclePath of findCycles(packageGraph)) {
    cycles.push({
      kind: 'package-cycle',
      rule: 'no-package-cycle',
      path: cyclePath,
      message: `package cycle: ${cyclePath.join(' -> ')}`,
    });
  }

  violations.push(...checkGoServices(root, members));

  if (options.docs !== false) {
    const docPath = path.join(root, DOC_FILE);
    const expected = renderDependencyGraphDoc();
    const actual = existsSync(docPath) ? readFileSync(docPath, 'utf8') : null;
    if (actual !== expected) {
      violations.push(
        violation(
          {
            kind: 'docs',
            rule: 'docs-up-to-date',
            from: DOC_FILE,
            to: 'scripts/check-boundaries.mjs',
            message: `${DOC_FILE} is ${actual === null ? 'missing' : 'stale'}; regenerate it with \`pnpm boundaries:docs\``,
          },
          members,
        ),
      );
    }
  }

  const kindOrder = (/** @type {string} */ k) => VIOLATION_KINDS.indexOf(k);
  violations.sort(
    (a, b) =>
      kindOrder(a.kind) - kindOrder(b.kind) ||
      a.rule.localeCompare(b.rule) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
  );

  return {
    ok: violations.length === 0 && cycles.length === 0,
    root,
    summary: {
      members: members.length,
      modules,
      dependencies,
      violations: violations.length,
      cycles: cycles.length,
    },
    violations,
    cycles,
  };
}

/**
 * Renders docs/architecture/dependency-graph.md from the model. Deterministic: depends only on
 * the constants in this file.
 * @returns {string}
 */
export function renderDependencyGraphDoc() {
  const names = ELEMENT_TYPES.map((t) => t.name);
  const lines = [
    '# Allowed package dependency graph',
    '',
    '<!-- Generated by `pnpm boundaries:docs` from scripts/check-boundaries.mjs. Do not edit by hand:',
    '     `pnpm boundaries:check` fails when this file differs from the generated text. -->',
    '',
    'Every workspace member belongs to exactly one element type. `pnpm boundaries:check` (FOUND-005, #7)',
    'enforces the edges below on every import, including type-only imports (`import type`,',
    '`export type ... from`), dynamic `import()` and `require`, and on the workspace dependencies',
    'declared in each `package.json`. Imports resolve through the pnpm workspace symlinks to the real',
    'member paths; an import that cannot be resolved (for example an undeclared `@blackwing/*`',
    'dependency) is matched by its package name and also reported as unresolvable.',
    '',
    'The model lives in `scripts/check-boundaries.mjs` (`ELEMENT_TYPES`). To change the graph, edit it,',
    'run `pnpm boundaries:docs` and commit both files with an explanation of the new edge.',
    '',
    '## Element types',
    '',
    '| Type | May import | Members | Purpose |',
    '|---|---|---|---|',
    ...ELEMENT_TYPES.map(
      (t) =>
        `| \`${t.name}\` | ${t.mayImport.length === 0 ? 'nothing internal' : t.mayImport.map((n) => `\`${n}\``).join(', ')} | ${t.members.map((m) => `\`${m}\``).join(', ')} | ${t.summary} |`,
    ),
    '',
    'Members of `shared-lib` may depend on each other (for example `packages/config -> packages/errors`',
    'and `packages/logger -> packages/config`), and so may members of `service-lib`, but never in a',
    'cycle.',
    '',
    '## Graph',
    '',
    '```mermaid',
    'flowchart BT',
    ...ELEMENT_TYPES.map((t) => `  ${t.name.replace('-', '_')}["${t.name}"]`),
    ...ELEMENT_TYPES.flatMap((t) =>
      t.mayImport.map((to) => `  ${t.name.replace('-', '_')} --> ${to.replace('-', '_')}`),
    ),
    '```',
    '',
    'An arrow means "may import". Anything without an arrow is rejected.',
    '',
    '## Matrix',
    '',
    `| from \\ to | ${names.map((n) => `\`${n}\``).join(' | ')} |`,
    `|---|${names.map(() => ':---:').join('|')}|`,
    ...ELEMENT_TYPES.map(
      (t) =>
        `| \`${t.name}\` | ${names.map((n) => (t.mayImport.includes(n) ? 'yes' : 'no')).join(' | ')} |`,
    ),
    '',
    'A member never counts as a dependency of itself, so `app -> app` means "another app".',
    '',
    '## Additional rules',
    '',
    '- **Test code may also import `@blackwing/testing`, and only test code may.** Test code is any `*.test.*` or `*.spec.*` file, anything under a `test/`, `tests/`, `__tests__/`, `__fixtures__/`, `e2e/`, `testdata/` or `typefixtures/` directory, and `vitest.config.*` / `vitest.int.config.*` / `playwright.config.*` (`TEST_CODE_PATTERN`). In `package.json`, `@blackwing/testing` belongs in `devDependencies`. Test code gets no other exemption.',
    '- **No deep imports.** Import another member only through its public entry points (the targets of its `package.json` `exports`): `@blackwing/config`, never `@blackwing/config/src/...` and never a relative path into another member. An `exports` map must not expose a `./src/...` subpath.',
    `- **Sandbox code stays away from server-only packages.** ${SANDBOX_MEMBERS.map((m) => `\`${m}\``).join(' and ')} run inside agent sandboxes, which reach only the egress gateway, the model gateway and the Run Broker API (CONTEXT_PACK §4.1). Their production code must not reach ${SERVER_ONLY_MEMBERS.map((m) => `\`${m}\``).join(', ')}, directly or through another package (§8.6, §8.7).`,
    `- **The owner database pool stays with the migrate job.** \`@blackwing/db/owner\` (\`${DB_OWNER_ENTRY}\`) holds the owner-role pool that runs migrations. Only \`packages/db\`${DB_OWNER_IMPORTERS.map((m) => `, \`${m}\``).join('')} and test code may import it; runtime code uses the app-role pool from \`@blackwing/db\` and never loads owner credentials (CONTEXT_PACK §7, §8.6).`,
    '- **The Go service stays self-contained.** `apps/egress-gateway/go.mod` must not `replace` a module with a path outside the module, and its Go code must not import other paths of this repository.',
    '- **No cycles.** Package cycles (from imports and declared dependencies) and module cycles inside one package are reported separately from boundary violations.',
    '- **Every member is classified.** A new app or package fails the check until it is added to `ELEMENT_TYPES`.',
    '',
    '## Commands and report',
    '',
    '| Command | Does |',
    '|---|---|',
    '| `pnpm boundaries:check` | Checks the whole workspace and this file. Exits 1 and names each offending edge on violation. |',
    '| `pnpm boundaries:report` | Same check, and also writes `boundaries-report.json` for CI annotation. |',
    '| `pnpm boundaries:docs` | Regenerates this file from the model. |',
    '',
    'The JSON report has `ok`, `summary`, `violations` and `cycles`. Each violation carries `kind`',
    `(${VIOLATION_KINDS.map((k) => `\`${k}\``).join(', ')}), \`rule\`, \`from\`, \`to\`,`,
    '`specifier` (the import as written), `fromMember`, `fromType`, `toMember`, `toType`, `via` (for',
    'transitive violations) and `message`.',
    'Each cycle carries `kind` (`package-cycle` or `module-cycle`), `rule`, `path` and `message`. Under',
    'GitHub Actions every problem is also printed as an `::error` annotation.',
    '',
  ];
  return lines.join('\n');
}

/**
 * @param {BoundaryReport} report
 * @returns {string}
 */
export function formatReport(report) {
  if (report.ok) {
    return `boundaries: ok (${report.summary.members} members, ${report.summary.modules} modules, ${report.summary.dependencies} dependencies)\n`;
  }
  const out = [];
  if (report.violations.length > 0) {
    out.push(`boundaries: ${report.violations.length} violation(s):`);
    for (const v of report.violations) out.push(`  [${v.kind}] ${v.rule}: ${v.message}`);
  }
  if (report.cycles.length > 0) {
    out.push(
      `boundaries: ${report.cycles.length} circular dependenc${report.cycles.length === 1 ? 'y' : 'ies'}:`,
    );
    for (const c of report.cycles) out.push(`  [${c.kind}] ${c.message}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * GitHub Actions workflow-command annotations, one per problem.
 * @param {BoundaryReport} report
 * @returns {string}
 */
export function formatAnnotations(report) {
  const esc = (/** @type {string} */ s) =>
    s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const escProp = (/** @type {string} */ s) => esc(s).replaceAll(':', '%3A').replaceAll(',', '%2C');
  const lines = [
    ...report.violations.map(
      (v) =>
        `::error file=${escProp(v.from)},title=${escProp(`boundaries ${v.rule}`)}::${esc(v.message)}`,
    ),
    ...report.cycles.map(
      (c) =>
        `::error file=${escProp(c.path[0] ?? '')},title=${escProp(`boundaries ${c.rule}`)}::${esc(c.message)}`,
    ),
  ];
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, json: string | null, writeDocs: boolean, quiet: boolean }}
 */
export function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  /** @type {string | null} */
  let json = null;
  let writeDocs = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg ?? ''} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--root') root = path.resolve(value());
    else if (arg === '--json') json = value();
    else if (arg === '--write-docs') writeDocs = true;
    else if (arg === '--quiet') quiet = true;
    else throw new Error(`unknown argument: ${arg ?? ''}`);
  }
  return { root, json, writeDocs, quiet };
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `check-boundaries: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  let report;
  try {
    if (args.writeDocs) {
      writeFileSync(path.join(args.root, DOC_FILE), renderDependencyGraphDoc());
      if (!args.quiet) process.stdout.write(`check-boundaries: wrote ${DOC_FILE}\n`);
    }
    report = await checkBoundaries(args.root);
  } catch (error) {
    process.stderr.write(
      `check-boundaries: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 2;
  }
  if (args.json !== null) {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (args.json === '-') process.stdout.write(text);
    else writeFileSync(path.resolve(args.json), text);
  }
  const human = formatReport(report);
  if (!report.ok) {
    process.stderr.write(human);
    if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(formatAnnotations(report));
    return 1;
  }
  if (!args.quiet && args.json !== '-') process.stdout.write(human);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
