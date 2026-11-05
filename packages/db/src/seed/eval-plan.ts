// Eval tenant seed (EVAL-001, #796): the `eval` tenant that owns the lab targets the eval harness runs against.
// One verified asset per target (the public training apps and the Blackwing synthetic labs), one active
// standing authorisation covering all of them at `active_safe`, and the two personas that request and approve
// it (separation of duties, §8.4). Pure: no IO. The targets arrive as parsed manifests from eval/targets.

import {
  type Asset,
  assertLabScope,
  assetSchema,
  type LabRuleEnv,
  type LabScopeDecision,
  parseScopeRules,
  type ScopeRulesInput,
  standingAuthorisationSchema,
  type StandingAuthorisation,
} from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';
import { addDuration, fromIso, type IsoTimestamp, toIso } from '@blackwing/time';

import {
  assertSeparationOfDuties,
  devSign,
  type PersonaKey,
  SEED_LAB_CIDR,
  SEED_PERSONAS,
  SEED_SA_LIFETIME,
  type SeedAssetRow,
  type SeedMembershipRow,
  type SeedStandingAuthorisationRow,
  type SeedTenantRow,
  type SeedTenantSpec,
  seedUuid,
  tenantRow,
} from './plan.js';

import type { Uuid } from '@blackwing/ids';

/** The eval tenant (EVAL-001). Its slug is the namespace of its assets and of the eval SA. */
const EVAL_TENANT: SeedTenantSpec = Object.freeze({
  slug: 'eval',
  name: 'Blackwing eval (lab targets)',
  region: 'eu-west-1',
  plan: 'dev',
});

/** The personas that hold the eval tenant: the requester (AppSec) and the approver (Asset Owner). */
const EVAL_REQUESTER: PersonaKey = 'appsec';
const EVAL_APPROVER: PersonaKey = 'owner';

/** One target as the seed needs it: the manifest's name, title, asset type and in-network address. */
export interface EvalSeedTarget {
  readonly name: string;
  readonly title: string;
  readonly assetType: Asset['type'];
  /** The compose service name on the lab network (`bw-targets`); never a loopback address. */
  readonly service: string;
  /** The container port the service listens on. */
  readonly port: number;
}

export interface EvalTenantSeedInput {
  readonly now: IsoTimestamp;
  readonly tenantId: Uuid;
  /** `users.id` per persona, as stored (the eval tenant reuses the demo personas). */
  readonly userIds: Readonly<Record<PersonaKey, Uuid>>;
  readonly targets: readonly EvalSeedTarget[];
  /** The verified lab network (default {@link SEED_LAB_CIDR}, the compose `bw-targets` subnet). */
  readonly labCidr?: string;
  /** `BW_ENV` for the lab gate (default `dev`). */
  readonly labEnv?: LabRuleEnv;
}

export interface EvalTenantSeedPlan {
  readonly tenantId: Uuid;
  readonly memberships: readonly SeedMembershipRow[];
  readonly assets: readonly SeedAssetRow[];
  readonly standingAuthorisation: SeedStandingAuthorisationRow;
  /** The lab gate's decisions, summed over every target's private-range rule (#880). */
  readonly labScope: LabScopeDecision;
}

/** The eval tenant row (platform scope; same shape as the demo tenant). */
export function evalTenantRow(now: IsoTimestamp): SeedTenantRow {
  return tenantRow(now, EVAL_TENANT);
}

/** The dev attestation every seeded verified asset carries (F6). The owner is the only contact. */
function devAttestation(): Readonly<Record<string, unknown>> {
  return {
    environmentType: 'dev',
    sharedDatabase: false,
    sharedLoginService: false,
    thirdPartyHosting: false,
    lockoutExemption: true,
    contacts: [{ name: 'Olive Owner', email: 'owner@acme.test', role: 'asset_owner' }],
  };
}

/** Per-target scope: the service's own host and port, plus the lab-network range on that port (#880). */
function targetScopeRules(target: EvalSeedTarget, labCidr: string): ScopeRulesInput['rules'] {
  return [
    { effect: 'include', host: target.service, ports: [target.port] },
    { effect: 'include', cidr: labCidr, ports: [target.port] },
  ];
}

/**
 * Builds and validates every eval-tenant row. Throws a `ValidationError` for a separation-of-duties breach, an
 * empty target list, a duplicate target name, or any row the contracts reject. Every target is a verified dev
 * asset, and the lab gate must admit each private-range rule before the SA is written.
 */
export function buildEvalTenantSeedPlan(input: EvalTenantSeedInput): EvalTenantSeedPlan {
  const { now, tenantId, userIds } = input;
  const labCidr = input.labCidr ?? SEED_LAB_CIDR;
  const labEnv = input.labEnv ?? 'dev';
  const requesterId = userIds[EVAL_REQUESTER];
  const approverId = userIds[EVAL_APPROVER];
  assertSeparationOfDuties(requesterId, approverId);
  if (input.targets.length === 0)
    throw new ValidationError('the eval tenant needs at least one target');
  const names = input.targets.map((target) => target.name);
  if (new Set(names).size !== names.length) {
    throw new ValidationError('eval target names must be unique');
  }

  const memberships: SeedMembershipRow[] = SEED_PERSONAS.flatMap((persona) =>
    (persona.key === EVAL_REQUESTER || persona.key === EVAL_APPROVER) && persona.roles !== null
      ? [{ userId: userIds[persona.key], roles: persona.roles }]
      : [],
  );

  const assets: SeedAssetRow[] = [];
  const rules: ScopeRulesInput['rules'] = [];
  let privateRuleCount = 0;
  for (const target of input.targets) {
    const asset: SeedAssetRow = {
      id: seedUuid(`${tenantId}:asset:${target.name}`),
      type: target.assetType,
      name: `${target.title} (eval lab)`,
      identifiers: [{ kind: 'url', value: `http://${target.service}:${target.port}` }],
      environment: 'dev',
      ownerUserId: userIds[EVAL_APPROVER],
      verificationStatus: 'verified',
      verificationMethod: 'manual_letter',
      attestation: devAttestation(),
    };
    assetSchema.parse({
      id: asset.id,
      tenantId,
      type: asset.type,
      identifiers: asset.identifiers,
      environment: asset.environment,
      ownerUserId: asset.ownerUserId,
      verificationStatus: asset.verificationStatus,
      verificationMethod: asset.verificationMethod,
      createdAt: now,
      updatedAt: now,
    });
    const targetRules = targetScopeRules(target, labCidr);
    const decision = assertLabScope({
      env: labEnv,
      asset: {
        environment: asset.environment,
        verificationStatus: asset.verificationStatus,
        verificationMethod: asset.verificationMethod,
      },
      labNetworks: [labCidr],
      rules: parseScopeRules({ rules: targetRules }),
    });
    privateRuleCount += decision.privateRuleCount;
    rules.push(...targetRules);
    assets.push(asset);
  }

  const scopeRules: StandingAuthorisation['scopeRules'] = parseScopeRules({ rules });
  const body = {
    id: seedUuid(`${tenantId}:sa:eval-targets`),
    tenantId,
    assetIds: assets.map((asset) => asset.id),
    scopeRules,
    maxIntrusiveness: 'active_safe' as const,
    preApprovedTestClasses: ['passive', 'active_safe'],
    defaultBudgets: { costCapUsd: 10, maxRequests: 40_000, maxDurationMs: 3_600_000 },
    testWindows: [{ cron: '0 0 * * *', timezone: 'UTC', durationMs: 86_400_000 }],
    validFrom: now,
    expiresAt: toIso(addDuration(fromIso(now), SEED_SA_LIFETIME)),
    requesterId,
    approverId,
  };
  const { signature, signingKeyId } = devSign(body);
  const standingAuthorisation: SeedStandingAuthorisationRow = {
    ...body,
    signature,
    signingKeyId,
    status: 'active',
  };
  standingAuthorisationSchema.parse({
    ...body,
    signature,
    signingKeyId,
    status: 'active',
    revocationReason: null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    tenantId,
    memberships,
    assets,
    standingAuthorisation,
    labScope: { privateRuleCount, labNetworks: [labCidr] },
  };
}
