import {
  type Cidr,
  cidrContains,
  normaliseHost,
  normalisePath,
  parseCidr,
  parseIp,
  type PortSpec,
  type ScopeDecision,
  type ScopeRule,
  type ScopeRules,
  type ScopeTarget,
} from '@blackwing/contracts';

/**
 * Deterministic scope matcher (SCOPE-002, §8.2, §8.11). Pure and stateless; callers log `reason`
 * and audit the decision. The Go egress matcher (EGRESS-004) must give identical results on
 * `@blackwing/contracts/scope.vectors.json`.
 *
 * Semantics:
 * 1. Default-deny: no matching `include` ⇒ out of scope.
 * 2. A rule matches when every dimension it sets matches the target. A dimension the rule leaves
 *    unset matches anything.
 * 3. Missing target fields are conservative: a rule that constrains a dimension the target lacks
 *    never brings it into scope. An `include` constraining a missing port, path or method does not
 *    match; an `exclude` constraining a missing port, path or method still matches (it cannot be
 *    ruled out, so it fails closed). Host and cidr select rules: a host rule never matches an
 *    IP-only target and a cidr rule never matches a hostname-only target, for either effect.
 * 4. Of all matching rules the most specific wins. Specificity is compared lexicographically as
 *    [address, cidrPrefix, path, port, method] with
 *      address: exact host 3 > wildcard host 2 > cidr 1 > none 0;
 *      cidrPrefix: the CIDR prefix length in the 128-bit space (longer wins), 0 if none;
 *      path: exact 2 > glob 1 > none 0;
 *      port: only single ports 2 > any range 1 > none 0;
 *      method: listed 1 > none 0.
 *    On equal specificity `exclude` beats `include` (fail closed); then the earlier rule wins.
 * 5. Host rules match hostname targets and cidr rules match IP targets; a host rule never
 *    authorises the IPs a name resolves to (the gateway re-checks the pinned IP itself).
 * 6. Invalid target values (bad host, IP, port, path or method) are out of scope.
 */

type Specificity = readonly [number, number, number, number, number];

const PORT_MAX = 65_535;
const GLOB_CACHE_MAX = 4096;
const SPEC_EXACT_HOST = 3;
const SPEC_WILDCARD_HOST = 2;
const SPEC_CIDR = 1;
const SPEC_EXACT = 2;
const SPEC_PARTIAL = 1;

interface NormalisedTarget {
  readonly host?: string;
  readonly ip?: bigint;
  readonly port?: number;
  readonly path?: string;
  readonly method?: string;
}

type TargetResult =
  | { readonly ok: true; readonly target: NormalisedTarget }
  | { readonly ok: false; readonly reason: string };

function normaliseTarget(target: ScopeTarget): TargetResult {
  const out: { host?: string; ip?: bigint; port?: number; path?: string; method?: string } = {};
  if (target.host !== undefined) {
    const host = normaliseHost(target.host);
    if (host === null) return { ok: false, reason: 'invalid target host' };
    out.host = host;
  }
  if (target.ip !== undefined) {
    const ip = parseIp(target.ip);
    if (ip === null) return { ok: false, reason: 'invalid target ip' };
    out.ip = ip;
  }
  if (target.port !== undefined) {
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > PORT_MAX) {
      return { ok: false, reason: 'invalid target port' };
    }
    out.port = target.port;
  }
  if (target.path !== undefined) {
    const path = normalisePath(target.path);
    if (!path.ok) return { ok: false, reason: `invalid target path (${path.reason})` };
    out.path = path.path;
  }
  if (target.method !== undefined) {
    const method = target.method.toUpperCase();
    if (!/^[A-Z]{1,20}$/.test(method)) return { ok: false, reason: 'invalid target method' };
    out.method = method;
  }
  if (out.host === undefined && out.ip === undefined) {
    return { ok: false, reason: 'target has no host or ip' };
  }
  return { ok: true, target: out };
}

function hostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return pattern === host;
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && !label.includes('.');
}

const globCache = new Map<string, RegExp>();

function globRegex(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const segments = pattern.split('/').filter((s) => s !== '');
  let source = '';
  for (const segment of segments) {
    if (segment === '**') {
      source += '(?:/[^/]+)*';
    } else {
      const parts = segment.split(/\*+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      source += `/${parts.join('[^/]*')}`;
    }
  }
  const regex = new RegExp(`^${source === '' ? '/' : source}$`, 'u');
  if (globCache.size < GLOB_CACHE_MAX) globCache.set(pattern, regex);
  return regex;
}

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes('*')) return pattern === path;
  const regex = globRegex(pattern);
  return regex.test(path) || (path === '/' && regex.test(''));
}

function portMatches(spec: PortSpec, port: number): boolean {
  return typeof spec === 'number' ? spec === port : spec.from <= port && port <= spec.to;
}

/**
 * Outcome per dimension: matched, did not match, or the target lacks the dimension. Address
 * dimensions (host, cidr) select which rules apply at all, so a missing address is a miss for
 * both effects; only port, path and method can be `absent`.
 */
type DimensionResult = 'match' | 'miss' | 'absent';

function dimensions(rule: ScopeRule, cidr: Cidr | null, t: NormalisedTarget): DimensionResult[] {
  const results: DimensionResult[] = [];
  if (rule.host !== undefined) {
    const host = rule.host;
    results.push(t.host !== undefined && hostMatches(host, t.host) ? 'match' : 'miss');
  }
  if (cidr !== null) {
    results.push(t.ip !== undefined && cidrContains(cidr, t.ip) ? 'match' : 'miss');
  }
  if (rule.ports !== undefined) {
    const port = t.port;
    results.push(
      port === undefined
        ? 'absent'
        : rule.ports.some((s) => portMatches(s, port))
          ? 'match'
          : 'miss',
    );
  }
  if (rule.paths !== undefined) {
    const path = t.path;
    results.push(
      path === undefined
        ? 'absent'
        : rule.paths.some((p) => pathMatches(p, path))
          ? 'match'
          : 'miss',
    );
  }
  if (rule.methods !== undefined) {
    const method = t.method;
    results.push(
      method === undefined
        ? 'absent'
        : (rule.methods as readonly string[]).includes(method)
          ? 'match'
          : 'miss',
    );
  }
  return results;
}

/** Specificity vector of a rule (see the module docs). Exported for the Go parity docs/tests. */
export function ruleSpecificity(rule: ScopeRule): Specificity {
  const cidr = rule.cidr === undefined ? null : parseCidr(rule.cidr);
  let address = 0;
  if (rule.host !== undefined) {
    address = rule.host.startsWith('*.') ? SPEC_WILDCARD_HOST : SPEC_EXACT_HOST;
  } else if (cidr !== null) {
    address = SPEC_CIDR;
  }
  let path = 0;
  if (rule.paths !== undefined) {
    path = rule.paths.every((p) => !p.includes('*')) ? SPEC_EXACT : SPEC_PARTIAL;
  }
  let port = 0;
  if (rule.ports !== undefined) {
    port = rule.ports.every((s) => typeof s === 'number') ? SPEC_EXACT : SPEC_PARTIAL;
  }
  const method = rule.methods === undefined ? 0 : 1;
  return [address, cidr?.prefix ?? 0, path, port, method];
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < a.length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Decides whether `target` is in scope under the ordered `rules` (already parsed and canonical,
 * see `parseScopeRules`). Never throws for any target input; anything unexpected is out of scope.
 */
export function matchScope(target: ScopeTarget, rules: ScopeRules): ScopeDecision {
  if (rules.rules.length === 0) return { inScope: false, reason: 'default-deny: no rules' };
  const normalised = normaliseTarget(target);
  if (!normalised.ok) return { inScope: false, reason: `default-deny: ${normalised.reason}` };
  const t = normalised.target;

  let best: { index: number; rule: ScopeRule; specificity: Specificity } | undefined;
  rules.rules.forEach((rule, index) => {
    const cidr = rule.cidr === undefined ? null : parseCidr(rule.cidr);
    if (rule.cidr !== undefined && cidr === null) return; // never for parsed rules
    const results = dimensions(rule, cidr, t);
    const matches =
      rule.effect === 'include'
        ? results.every((r) => r === 'match')
        : results.every((r) => r !== 'miss');
    if (!matches) return;
    const specificity = ruleSpecificity(rule);
    if (best === undefined) {
      best = { index, rule, specificity };
      return;
    }
    const cmp = compareSpecificity(specificity, best.specificity);
    if (cmp > 0 || (cmp === 0 && rule.effect === 'exclude' && best.rule.effect === 'include')) {
      best = { index, rule, specificity };
    }
  });

  if (best === undefined) return { inScope: false, reason: 'default-deny: no rule matched' };
  if (best.rule.effect === 'exclude') {
    return {
      inScope: false,
      matchedRule: best.rule,
      matchedRuleIndex: best.index,
      reason: `excluded by rule ${best.index}`,
    };
  }
  return {
    inScope: true,
    matchedRule: best.rule,
    matchedRuleIndex: best.index,
    reason: `included by rule ${best.index}`,
  };
}
