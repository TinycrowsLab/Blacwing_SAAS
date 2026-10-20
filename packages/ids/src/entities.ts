import type { BrandOf, IdPrefix } from "./prefixes.js";
import { isPublicId, newPublicId, parsePublicId, type PublicId, toPublicId, toUuid } from "./public-id.js";
import type { Uuid } from "./uuid.js";

/** Runtime constructor for one entity's branded public id. Every method validates; none trusts its input. */
export interface IdType<P extends IdPrefix> {
  /** The registered prefix, e.g. `"run"`. */
  readonly prefix: P;
  /** The brand name, e.g. `"RunId"`. */
  readonly brand: BrandOf<P>;
  /** Validates `value` as a public id with this prefix. Throws `IdValidationError` (e.g. `prefix_mismatch`). */
  parse(value: unknown): PublicId<P>;
  /** Non-throwing check for this prefix. */
  is(value: unknown): value is PublicId<P>;
  /** Builds the public id for a stored UUIDv7 (e.g. a DB row's `id`). */
  fromUuid(uuid: unknown): PublicId<P>;
  /** The UUIDv7 behind a public id of this entity (validated again, so plain strings are safe to pass). */
  toUuid(value: unknown): Uuid;
  /** A fresh public id backed by a new UUIDv7. */
  generate(): PublicId<P>;
}

/** Creates the constructor for a prefix. */
export function defineIdType<P extends IdPrefix>(prefix: P, brand: BrandOf<P>): IdType<P> {
  return Object.freeze({
    prefix,
    brand,
    // `ParsedPublicId<P>` is distributive, so for a generic `P` TypeScript widens `.id` to every brand;
    // `parsePublicId(value, prefix)` has just verified the prefix is exactly `P`.
    parse: (value: unknown): PublicId<P> => parsePublicId(value, prefix).id as PublicId<P>,
    is: (value: unknown): value is PublicId<P> => isPublicId(value, prefix),
    fromUuid: (uuid: unknown): PublicId<P> => toPublicId(uuid, prefix),
    toUuid: (value: unknown): Uuid => toUuid(value, prefix),
    generate: (): PublicId<P> => newPublicId(prefix),
  });
}

// One branded type and one same-named constructor per registered prefix. The type and the value
// share a name (`RunId` the type, `RunId.parse(...)` the constructor), so call sites read naturally.

/** `run_…` */
export type RunId = PublicId<"run">;
export const RunId = defineIdType("run", "RunId");
/** `fnd_…` */
export type FindingId = PublicId<"fnd">;
export const FindingId = defineIdType("fnd", "FindingId");
/** `asset_…` */
export type AssetId = PublicId<"asset">;
export const AssetId = defineIdType("asset", "AssetId");
/** `sa_…` */
export type StandingAuthorisationId = PublicId<"sa">;
export const StandingAuthorisationId = defineIdType("sa", "StandingAuthorisationId");
/** `tp_…` */
export type TestPlanId = PublicId<"tp">;
export const TestPlanId = defineIdType("tp", "TestPlanId");
/** `tc_…` */
export type TestCaseId = PublicId<"tc">;
export const TestCaseId = defineIdType("tc", "TestCaseId");
/** `sub_…` */
export type SubtaskId = PublicId<"sub">;
export const SubtaskId = defineIdType("sub", "SubtaskId");
/** `sess_…` */
export type SessionId = PublicId<"sess">;
export const SessionId = defineIdType("sess", "SessionId");
/** `evd_…` */
export type EvidenceId = PublicId<"evd">;
export const EvidenceId = defineIdType("evd", "EvidenceId");
/** `tok_…` */
export type ApiTokenId = PublicId<"tok">;
export const ApiTokenId = defineIdType("tok", "ApiTokenId");
/** `ten_…` */
export type TenantId = PublicId<"ten">;
export const TenantId = defineIdType("ten", "TenantId");
/** `usr_…` */
export type UserId = PublicId<"usr">;
export const UserId = defineIdType("usr", "UserId");
/** `oob_…` */
export type OobId = PublicId<"oob">;
export const OobId = defineIdType("oob", "OobId");
/** `kill_…` */
export type KillEventId = PublicId<"kill">;
export const KillEventId = defineIdType("kill", "KillEventId");

/** Every entity constructor keyed by prefix, for code that picks the entity at runtime (e.g. the DB layer). */
export const ID_TYPES: { readonly [P in IdPrefix]: IdType<P> } = Object.freeze({
  run: RunId,
  fnd: FindingId,
  asset: AssetId,
  sa: StandingAuthorisationId,
  tp: TestPlanId,
  tc: TestCaseId,
  sub: SubtaskId,
  sess: SessionId,
  evd: EvidenceId,
  tok: ApiTokenId,
  ten: TenantId,
  usr: UserId,
  oob: OobId,
  kill: KillEventId,
});
