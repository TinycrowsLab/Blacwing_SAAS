// Dev seed data (DEVENV-011, CONTEXT_PACK §7, §10): the demo tenant `acme`, one user per persona, a
// verified Juice Shop lab asset, credentials by OpenBao reference, an active standing authorisation and
// a role matrix. Pure: no IO. Every row is validated against the shared contracts before it is written.

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import {
  type Asset,
  assertLabScope,
  assetSchema,
  type AssetIdentifier,
  type LabRuleEnv,
  type LabScopeDecision,
  type Role,
  type StandingAuthorisation,
  standingAuthorisationSchema,
  tenantSchema,
  userSchema,
  normaliseIp,
  parseScopeRules,
} from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';
import { isUuidV7, type Uuid } from '@blackwing/ids';
import { addDuration, fromIso, type IsoTimestamp, toIso } from '@blackwing/time';

/** Fixed timestamp (2026-01-01T00:00:00Z) carried by every deterministic seed id. */
const SEED_ID_EPOCH_MS = 1_767_225_600_000;
const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;
const VERSION_BYTE = 6;
const VARIANT_BYTE = 8;
const LOW_NIBBLE = 0x0f;
const VERSION_7 = 0x70;
const VARIANT_LOW_BITS = 0x3f;
const VARIANT_RFC9562 = 0x80;
const UUID_SHAPE = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/;

/**
 * A deterministic UUIDv7 for seed row `key`: the fixed seed timestamp, then 74 bits of
 * SHA-256(`key`). Re-running the seed therefore targets the same primary keys, so upserts converge
 * after a partial run instead of duplicating rows.
 */
export function seedUuid(key: string): Uuid {
  const digest = createHash('sha256').update(`blackwing-seed:${key}`).digest();
  const bytes = Buffer.alloc(UUID_BYTES);
  bytes.writeUIntBE(SEED_ID_EPOCH_MS, 0, TIMESTAMP_BYTES);
  digest.copy(bytes, TIMESTAMP_BYTES, 0, UUID_BYTES - TIMESTAMP_BYTES);
  bytes.writeUInt8((bytes.readUInt8(VERSION_BYTE) & LOW_NIBBLE) | VERSION_7, VERSION_BYTE);
  bytes.writeUInt8(
    (bytes.readUInt8(VARIANT_BYTE) & VARIANT_LOW_BITS) | VARIANT_RFC9562,
    VARIANT_BYTE,
  );
  const uuid = bytes.toString('hex').replace(UUID_SHAPE, '$1-$2-$3-$4-$5');
  if (!isUuidV7(uuid)) throw new ValidationError(`seed id for ${key} is not a UUIDv7`);
  return uuid as Uuid;
}

/** The demo tenant (§10). */
const SEED_TENANT = Object.freeze({
  slug: 'acme',
  name: 'Acme Corp (demo)',
  region: 'eu-west-1',
  plan: 'dev',
} as const);

/** Persona keys; each matches a Keycloak test user in realm `blackwing-dev` (DEVENV-004). */
export const PERSONA_KEYS = ['appsec', 'owner', 'dev', 'admin', 'auditor', 'operator'] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];

export interface SeedPersona {
  readonly key: PersonaKey;
  /** Keycloak username (the realm uses the e-mail address). */
  readonly username: string;
  readonly email: string;
  readonly name: string;
  /** `memberships.roles[]` in `acme`; `null` for the Platform Operator, who is never a tenant member. */
  readonly roles: readonly Role[] | null;
}

/** One user per persona (§1.2). Dev passwords live only in Keycloak dev (§10), never here. */
export const SEED_PERSONAS: readonly SeedPersona[] = Object.freeze([
  {
    key: 'appsec',
    username: 'appsec@acme.test',
    email: 'appsec@acme.test',
    name: 'Ada AppSec',
    roles: ['appsec_engineer'],
  },
  {
    key: 'owner',
    username: 'owner@acme.test',
    email: 'owner@acme.test',
    name: 'Omar Owner',
    roles: ['asset_owner'],
  },
  {
    key: 'dev',
    username: 'dev@acme.test',
    email: 'dev@acme.test',
    name: 'Dana Developer',
    roles: ['developer'],
  },
  {
    key: 'admin',
    username: 'admin@acme.test',
    email: 'admin@acme.test',
    name: 'Alex Admin',
    roles: ['org_admin'],
  },
  {
    key: 'auditor',
    username: 'auditor@acme.test',
    email: 'auditor@acme.test',
    name: 'Audrey Auditor',
    roles: ['auditor'],
  },
  {
    key: 'operator',
    username: 'operator@blackwing.test',
    email: 'operator@blackwing.test',
    name: 'Blackwing Platform Operator',
    roles: null,
  },
]);

/**
 * The compose lab network (`bw-targets`, #880): the only private range the seed admits, and only as
 * a dev scope rule for the verified Juice Shop lab asset. Matches the subnet in docker-compose.dev.yml.
 */
export const SEED_LAB_CIDR = '172.30.250.0/24';

/** Lifetime of the seeded SA, counted from the seed time (re-seeding renews it). */
const SEED_SA_LIFETIME = '90d';

/** Juice Shop application roles that get a credential (§7 `asset_credentials`). */
const SEED_CREDENTIAL_ROLES = ['customer', 'admin'] as const;

/**
 * An OpenBao KV v2 reference (DEVENV-005): `openbao://secret/data/tenants/<slug>/...`. Only a
 * reference is ever stored; the session manager and egress gateway resolve it (§8.7).
 */
const SECRET_REF = /^openbao:\/\/secret\/data\/tenants\/[a-z0-9-]+(?:\/[a-z0-9_-]+)+$/;

/** Throws unless `value` is an OpenBao reference (never a credential, URL with userinfo or token). */
export function assertSecretRef(value: string): void {
  if (!SECRET_REF.test(value)) {
    throw new ValidationError(
      'asset_credentials.secret_ref must be an openbao://secret/data/tenants/... reference, never a credential (§8.7)',
    );
  }
}

/** Throws when the SA requester is also its approver (separation of duties, §8.4). */
export function assertSeparationOfDuties(requesterId: string, approverId: string): void {
  if (requesterId === approverId) {
    throw new ValidationError('the SA approver must not be the requester (§8.4)');
  }
}

export interface SeedTenantRow {
  readonly id: Uuid;
  readonly slug: string;
  readonly name: string;
  readonly status: 'active';
  readonly region: string;
  readonly plan: string;
}

/** The tenant row (platform scope; created before any tenant-scoped insert). */
export function tenantRow(now: IsoTimestamp): SeedTenantRow {
  const row = {
    id: seedUuid(`tenant:${SEED_TENANT.slug}`),
    slug: SEED_TENANT.slug,
    name: SEED_TENANT.name,
    status: 'active' as const,
    region: SEED_TENANT.region,
    plan: SEED_TENANT.plan,
  };
  tenantSchema.parse({ ...row, createdAt: now, updatedAt: now });
  return row;
}

export interface SeedUserRow {
  readonly id: Uuid;
  readonly persona: PersonaKey;
  readonly keycloakSub: string;
  readonly email: string;
  readonly name: string;
  readonly status: 'active';
}

/** Placeholder subject for a persona Keycloak could not confirm; replaced once Keycloak answers. */
function pendingSubject(persona: SeedPersona): string {
  return `pending:${persona.username}`;
}

/** User rows; `subjects` holds the Keycloak `sub` per persona that Keycloak confirmed. */
export function userRows(
  now: IsoTimestamp,
  subjects: Readonly<Partial<Record<PersonaKey, string>>>,
): SeedUserRow[] {
  return SEED_PERSONAS.map((persona) => {
    const row = {
      id: seedUuid(`user:${persona.email}`),
      persona: persona.key,
      keycloakSub: subjects[persona.key] ?? pendingSubject(persona),
      email: persona.email,
      name: persona.name,
      status: 'active' as const,
    };
    userSchema.parse({
      id: row.id,
      keycloakSub: row.keycloakSub,
      email: row.email,
      name: row.name,
      status: row.status,
      createdAt: now,
      updatedAt: now,
    });
    return row;
  });
}

interface SeedMembershipRow {
  readonly userId: Uuid;
  readonly roles: readonly Role[];
}

interface SeedAssetRow {
  readonly id: Uuid;
  readonly type: Asset['type'];
  readonly name: string;
  readonly identifiers: readonly AssetIdentifier[];
  readonly environment: Asset['environment'];
  readonly ownerUserId: Uuid;
  readonly verificationStatus: 'verified';
  readonly verificationMethod: 'manual_letter';
  /** F6 attestation. */
  readonly attestation: Readonly<Record<string, unknown>>;
}

interface SeedCredentialRow {
  readonly id: Uuid;
  readonly assetId: Uuid;
  readonly roleName: string;
  readonly secretRef: string;
  readonly loginRecipe: Readonly<Record<string, unknown>>;
  readonly mfaType: 'none';
}

interface SeedStandingAuthorisationRow {
  readonly id: Uuid;
  readonly assetIds: readonly Uuid[];
  readonly scopeRules: StandingAuthorisation['scopeRules'];
  readonly maxIntrusiveness: 'active_safe';
  readonly preApprovedTestClasses: readonly string[];
  readonly defaultBudgets: StandingAuthorisation['defaultBudgets'];
  readonly testWindows: StandingAuthorisation['testWindows'];
  readonly validFrom: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly requesterId: Uuid;
  readonly approverId: Uuid;
  readonly signature: string;
  readonly signingKeyId: string;
  readonly status: 'active';
}

type Access = 'allow' | 'deny';

interface SeedRoleMatrixRow {
  readonly id: Uuid;
  readonly assetId: Uuid;
  readonly version: number;
  readonly active: boolean;
  /** `{ roles, functions }`: functions × roles → expected access (F9). The database stores it as one object. */
  readonly matrix: {
    readonly roles: readonly string[];
    readonly functions: readonly {
      readonly function: string;
      readonly method: string;
      readonly path: string;
      readonly expected: Readonly<Record<string, Access>>;
    }[];
  };
}

/** Everything written under the tenant context. */
export interface TenantSeedPlan {
  readonly tenantId: Uuid;
  readonly memberships: readonly SeedMembershipRow[];
  readonly asset: SeedAssetRow;
  readonly credentials: readonly SeedCredentialRow[];
  readonly standingAuthorisation: SeedStandingAuthorisationRow;
  readonly roleMatrix: SeedRoleMatrixRow;
  /** The lab gate's decision on the seeded private-range rule (#880). */
  readonly labScope: LabScopeDecision;
}

export interface TenantSeedInput {
  readonly now: IsoTimestamp;
  readonly tenantId: Uuid;
  /** `users.id` per persona, as stored. */
  readonly userIds: Readonly<Record<PersonaKey, Uuid>>;
  /**
   * The Juice Shop address the egress gateway targets: the compose service name on the lab network
   * (`BW_TARGET_JUICE_SHOP_GATEWAY_URL`, #880). Never `localhost`.
   */
  readonly juiceShopUrl: string;
  /** The verified lab network (default {@link SEED_LAB_CIDR}). */
  readonly labCidr?: string;
  /** `BW_ENV` for the lab gate (default `dev`). Seeding refuses everything else before this runs. */
  readonly labEnv?: LabRuleEnv;
  /** Who requests and who approves the SA (defaults: AppSec requests, the Asset Owner approves). */
  readonly requester?: PersonaKey;
  readonly approver?: PersonaKey;
}

/** JSON with object keys sorted recursively (the JCS ordering, sufficient for this body). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const KEY_ID_HEX = 16;
const DEFAULT_PORT = { 'http:': 80, 'https:': 443 } as const;

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

/**
 * A dev JWS (EdDSA) over the canonical SA body, signed with a key generated for this seed run and then
 * discarded. The key is not in any trust store, so the envelope verifier (#375) rejects it until the
 * signing service exists: a seeded SA can never pass signature verification by accident (fail closed,
 * §8.1). Returns the compact JWS and its key id.
 */
export function devSign(body: unknown): { signature: string; signingKeyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const signingKeyId = `dev-seed-${createHash('sha256').update(der).digest('hex').slice(0, KEY_ID_HEX)}`;
  const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: signingKeyId, typ: 'JWT' }));
  const payload = b64url(canonicalJson(body));
  const sig = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return { signature: `${header}.${payload}.${b64url(sig)}`, signingKeyId };
}

/**
 * The seeded SA's scope rules (SCOPE-002 model): the Juice Shop origin on its port, minus one admin
 * path. An IP-literal target (e.g. `127.0.0.1`) is addressed by `cidr`, a hostname by `host`. The
 * lab cidr admits the address the compose service name resolves to; the lab gate decides whether it
 * may (#880).
 */
function seedScopeRules(
  target: { host: string; port: number },
  labCidr: string,
): StandingAuthorisation['scopeRules'] {
  const bare = target.host.replace(/^\[(.*)\]$/, '$1');
  const ip = normaliseIp(bare);
  const address = ip === null ? { host: target.host } : { cidr: ip };
  return parseScopeRules({
    rules: [
      { effect: 'include', ...address, ports: [target.port] },
      { effect: 'include', cidr: labCidr, ports: [target.port] },
      { effect: 'exclude', ...address, paths: ['/rest/admin/application-version'] },
    ],
  });
}

function juiceShopTarget(rawUrl: string): { url: string; host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError('the Juice Shop URL is not a valid URL');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '') {
    throw new ValidationError('the Juice Shop URL must be http(s) without credentials');
  }
  const port = parsed.port === '' ? DEFAULT_PORT[parsed.protocol] : Number(parsed.port);
  return { url: parsed.origin, host: parsed.hostname, port };
}

/** Juice Shop functions × roles → expected access (F9). */
const ROLE_MATRIX_ROLES = ['anonymous', 'customer', 'admin'] as const;
const ROLE_MATRIX_FUNCTIONS: SeedRoleMatrixRow['matrix']['functions'] = [
  {
    function: 'search_products',
    method: 'GET',
    path: '/rest/products/search',
    expected: { anonymous: 'allow', customer: 'allow', admin: 'allow' },
  },
  {
    function: 'view_own_basket',
    method: 'GET',
    path: '/rest/basket/{id}',
    expected: { anonymous: 'deny', customer: 'allow', admin: 'allow' },
  },
  {
    function: 'submit_feedback',
    method: 'POST',
    path: '/api/Feedbacks',
    expected: { anonymous: 'allow', customer: 'allow', admin: 'allow' },
  },
  {
    function: 'list_users',
    method: 'GET',
    path: '/api/Users',
    expected: { anonymous: 'deny', customer: 'deny', admin: 'allow' },
  },
  {
    function: 'administration',
    method: 'GET',
    path: '/rest/admin/application-configuration',
    expected: { anonymous: 'deny', customer: 'deny', admin: 'allow' },
  },
];

/**
 * Builds and validates every tenant-scoped row. Throws a `ValidationError` on a separation-of-duties
 * breach, a non-reference secret, or any row the contracts reject.
 */
export function buildTenantSeedPlan(input: TenantSeedInput): TenantSeedPlan {
  const { now, tenantId, userIds } = input;
  const target = juiceShopTarget(input.juiceShopUrl);
  const labCidr = input.labCidr ?? SEED_LAB_CIDR;
  const requesterId = userIds[input.requester ?? 'appsec'];
  const approverId = userIds[input.approver ?? 'owner'];
  assertSeparationOfDuties(requesterId, approverId);

  const memberships = SEED_PERSONAS.flatMap((persona) =>
    persona.roles === null ? [] : [{ userId: userIds[persona.key], roles: persona.roles }],
  );

  const asset: SeedAssetRow = {
    id: seedUuid(`${tenantId}:asset:juice-shop`),
    type: 'web_app',
    name: 'Juice Shop (local lab)',
    identifiers: [{ kind: 'url', value: target.url }],
    environment: 'dev',
    ownerUserId: userIds.owner,
    verificationStatus: 'verified',
    verificationMethod: 'manual_letter',
    attestation: {
      environmentType: 'dev',
      sharedDatabase: false,
      sharedLoginService: false,
      thirdPartyHosting: false,
      lockoutExemption: true,
      contacts: [{ name: 'Omar Owner', email: 'owner@acme.test', role: 'asset_owner' }],
    },
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

  const credentials: SeedCredentialRow[] = SEED_CREDENTIAL_ROLES.map((roleName) => {
    const row: SeedCredentialRow = {
      id: seedUuid(`${asset.id}:credential:${roleName}`),
      assetId: asset.id,
      roleName,
      secretRef: `openbao://secret/data/tenants/${SEED_TENANT.slug}/assets/juice-shop/credentials/${roleName}`,
      loginRecipe: {
        kind: 'json_form_post',
        url: `${target.url}/rest/user/login`,
        usernameField: 'email',
        passwordField: 'password',
        tokenPath: 'authentication.token',
        inject: { header: 'Authorization', scheme: 'Bearer' },
      },
      mfaType: 'none',
    };
    assertSecretRef(row.secretRef);
    return row;
  });

  const scopeRules = seedScopeRules(target, labCidr);
  const labScope = assertLabScope({
    env: input.labEnv ?? 'dev',
    asset: {
      environment: asset.environment,
      verificationStatus: asset.verificationStatus,
      verificationMethod: asset.verificationMethod,
    },
    labNetworks: [labCidr],
    rules: scopeRules,
  });

  const validFrom = now;
  const expiresAt = toIso(addDuration(fromIso(now), SEED_SA_LIFETIME));
  const body = {
    id: seedUuid(`${tenantId}:sa:juice-shop`),
    tenantId,
    assetIds: [asset.id],
    scopeRules,
    maxIntrusiveness: 'active_safe' as const,
    preApprovedTestClasses: ['passive', 'active_safe'],
    defaultBudgets: { costCapUsd: 5, maxRequests: 5_000, maxDurationMs: 3_600_000 },
    testWindows: [{ cron: '0 0 * * *', timezone: 'UTC', durationMs: 86_400_000 }],
    validFrom,
    expiresAt,
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

  const roleMatrix: SeedRoleMatrixRow = {
    id: seedUuid(`${asset.id}:role-matrix`),
    assetId: asset.id,
    version: 1,
    active: true,
    matrix: { roles: ROLE_MATRIX_ROLES, functions: ROLE_MATRIX_FUNCTIONS },
  };

  return {
    tenantId,
    memberships,
    asset,
    credentials,
    standingAuthorisation,
    roleMatrix,
    labScope,
  };
}
