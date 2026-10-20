/**
 * Length and range limits shared by the entity contracts. One place, so the API, the database
 * column sizes and the UI validation can agree on them.
 */
export const LIMITS = Object.freeze({
  /** Titles and display names. */
  labelMax: 200,
  /** Short keys and categories (test classes, roles, OWASP categories). */
  shortTextMax: 120,
  /** Identifiers such as plan names and oracle keys. */
  keyMax: 64,
  /** Free-text reasons (revocation, status, accepted risk). */
  reasonMax: 2000,
  /** Run objectives. */
  objectiveMax: 4000,
  /** URLs, URL templates and asset identifiers. */
  urlMax: 2048,
  /** Parameter names. */
  parameterMax: 512,
  /** Source file paths (white box). */
  filePathMax: 1024,
  /** A DNS name (RFC 1035). */
  hostnameMax: 253,
  /** Highest TCP/UDP port. */
  portMax: 65_535,
  /** OIDC `sub` claims. */
  subjectMax: 255,
  /** Tenant slug bounds. */
  slugMin: 3,
  slugMax: 63,
  /** IANA time-zone names. */
  timezoneMax: 64,
  /** Upper bound for a per-run cost cap, in USD. */
  costCapUsdMax: 100_000,
  /** Highest CVSS score. */
  cvssScoreMax: 10,
  /** Largest value of a Postgres `integer` column. */
  int32Max: 2_147_483_647,
  /** An e-mail address (RFC 5321 path limit). */
  emailMax: 320,
  /** Upper bound for the uses of one SOC kill-link token. */
  killTokenUsesMax: 1000,
} as const);
