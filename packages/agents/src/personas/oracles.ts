/**
 * The validation-oracle catalogue (CONTEXT_PACK §8.11, REFERENCES §7). Oracles are deterministic checks run
 * by the validator; personas only declare which type a test case needs, they never run or judge one.
 */
export const ORACLE_CATALOGUE = [
  'reflected_marker',
  'status_diff',
  'timing_with_baseline',
  'out_of_band',
  'access_matrix',
  'error_signature',
  'file_read',
  'header_flag',
] as const;
export type OracleCatalogueType = (typeof ORACLE_CATALOGUE)[number];
