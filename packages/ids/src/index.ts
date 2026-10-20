/** Workspace package name of this package. */
export const name = "@blackwing/ids";

/** Package version; kept in sync with package.json. */
export const version = "0.0.0";

export { CROCKFORD_ALPHABET, decodeBase32, encodeBase32, ENCODED_LENGTH, type Base32DecodeError } from "./base32.js";
export {
  AssetId,
  ApiTokenId,
  defineIdType,
  EvidenceId,
  FindingId,
  ID_TYPES,
  type IdType,
  KillEventId,
  OobId,
  RunId,
  SessionId,
  StandingAuthorisationId,
  SubtaskId,
  TenantId,
  TestCaseId,
  TestPlanId,
  UserId,
} from "./entities.js";
export { IdValidationError, type IdValidationReason, isIdValidationError } from "./errors.js";
export { type BrandOf, ID_PREFIX_LIST, ID_PREFIXES, type IdPrefix, isIdPrefix } from "./prefixes.js";
export {
  isPublicId,
  newPublicId,
  type ParsedPublicId,
  parsePublicId,
  PUBLIC_ID_SEPARATOR,
  type PublicId,
  toPublicId,
  toUuid,
} from "./public-id.js";
export {
  createUuidV7Generator,
  isUuidV7,
  newId,
  parseUuid,
  type Uuid,
  type UuidV7Generator,
  type UuidV7GeneratorOptions,
  uuidTimestamp,
} from "./uuid.js";
