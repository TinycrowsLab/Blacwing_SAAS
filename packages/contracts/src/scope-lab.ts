import { type Cidr, cidrContains, parseCidr, ScopeRuleError, type ScopeRules } from './scope.js';

/**
 * The lab gate for private-range scope rules (#880, CONTEXT_PACK §8.2). A scope rule that admits a
 * private, loopback, link-local or metadata address is refused at creation unless every condition
 * below holds. The egress gateway applies the same policy at snapshot load (`internal/scope/lab.go`),
 * and both run against the same table of ranges.
 *
 * - Loopback, link-local and the metadata service are never admitted.
 * - `BW_ENV` (`env`) is `dev` or `test`.
 * - The asset is verified through the dev attest path: environment `dev`, status `verified`, and a
 *   verification method recorded.
 * - The rule's cidr lies inside one of the verified lab networks, and each lab network is itself a
 *   private range (a public "lab" is refused).
 *
 * Host-only and exclude rules are not private-range rules and are not checked here.
 */

/** The `BW_ENV` values; private-range rules are admitted only in the first two. */
const LAB_RULE_ENVS = ['dev', 'test'] as const;
export type LabRuleEnv = (typeof LAB_RULE_ENVS)[number] | 'staging' | 'production';

/** The environment that the dev attest path accepts for a lab asset. */
const DEV_ATTEST_ENVIRONMENT = 'dev';

/** Blocked ranges, the same table as `internal/netguard` (CONTEXT_PACK §8.2). */
const BLOCKED_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '192.0.0.0/24',
  '198.18.0.0/15',
  '::1/128',
  '::/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '64:ff9b:1::/48',
] as const;

/** Ranges no scope rule may admit (loopback, link-local and metadata). */
const NEVER_IN_SCOPE = [
  '127.0.0.0/8',
  '::1/128',
  '169.254.0.0/16',
  'fe80::/10',
  '169.254.169.254/32',
  'fd00:ec2::254/128',
] as const;

function parseRanges(ranges: readonly string[]): Cidr[] {
  return ranges.map((text) => {
    const cidr = parseCidr(text);
    if (cidr === null) throw new Error(`built-in range ${text} does not parse`);
    return cidr;
  });
}

const BLOCKED = parseRanges(BLOCKED_RANGES);
const NEVER = parseRanges(NEVER_IN_SCOPE);

/** True when `outer` contains every address of `inner`. */
function contains(outer: Cidr, inner: Cidr): boolean {
  return outer.prefix <= inner.prefix && cidrContains(outer, inner.network);
}

function overlaps(a: Cidr, b: Cidr): boolean {
  return contains(a, b) || contains(b, a);
}

/** The lab asset facts the dev attest path reads. */
interface LabAssetFacts {
  readonly environment: string;
  readonly verificationStatus: string;
  readonly verificationMethod: string | null;
}

interface LabScopeInput {
  /** `BW_ENV` of the process creating or loading the rules. */
  readonly env: string;
  readonly asset: LabAssetFacts;
  /** The verified lab networks, as canonical CIDR text (the compose lab subnet). */
  readonly labNetworks: readonly string[];
  readonly rules: ScopeRules;
}

export interface LabScopeDecision {
  /** Include rules that admit a private range; each one passed every lab condition. */
  readonly privateRuleCount: number;
  /** The lab networks, parsed and canonical. */
  readonly labNetworks: readonly string[];
}

/** True when the asset passed the dev attest path (#880). */
function isDevAttested(asset: LabAssetFacts): boolean {
  return (
    asset.environment === DEV_ATTEST_ENVIRONMENT &&
    asset.verificationStatus === 'verified' &&
    asset.verificationMethod !== null
  );
}

function refuse(reason: string): never {
  throw new ScopeRuleError('SCOPE_INVALID_RULE', `private-range scope rule refused: ${reason}`, [
    'rules',
  ]);
}

/**
 * Admits or refuses the private-range rules of `input`, the rule-creation gate of #880.
 * @throws {ScopeRuleError} `SCOPE_INVALID_RULE` when a private-range rule is not admitted.
 */
export function assertLabScope(input: LabScopeInput): LabScopeDecision {
  const networks = input.labNetworks.map((text) => {
    const cidr = parseCidr(text);
    if (cidr === null) refuse('a lab network is not a valid CIDR');
    if (!BLOCKED.some((range) => contains(range, cidr)) || NEVER.some((r) => overlaps(r, cidr))) {
      refuse('a lab network is not a private range');
    }
    return cidr;
  });

  let privateRuleCount = 0;
  for (const [index, rule] of input.rules.rules.entries()) {
    if (rule.effect !== 'include' || rule.cidr === undefined) continue;
    const cidr = parseCidr(rule.cidr);
    if (cidr === null) refuse(`rules.${index}: cidr is not a valid CIDR`);
    if (!BLOCKED.some((range) => overlaps(range, cidr))) continue;
    if (NEVER.some((range) => overlaps(range, cidr))) {
      refuse(`rules.${index}: loopback, link-local and metadata are never in scope`);
    }
    if (!(LAB_RULE_ENVS as readonly string[]).includes(input.env)) {
      refuse(`rules.${index}: private-range rules need BW_ENV dev or test`);
    }
    if (!isDevAttested(input.asset)) {
      refuse(`rules.${index}: private-range rules need a verified lab asset (dev attest)`);
    }
    if (!networks.some((network) => contains(network, cidr))) {
      refuse(`rules.${index}: private range is outside the verified lab networks`);
    }
    privateRuleCount += 1;
  }

  return { privateRuleCount, labNetworks: input.labNetworks };
}
