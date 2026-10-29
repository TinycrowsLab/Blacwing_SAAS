/**
 * Separation of duties (F31, CONTEXT_PACK §8.4). Import as `@blackwing/domain/sod`. This is the only SoD error and
 * primitive set in the repository; consumers import it rather than redefining any part of it.
 */
export { sodCedarCondition } from './cedar.js';
export {
  sodCheckConstraint,
  sodTrigger,
  SOD_RAISE_PREFIX,
  SOD_SQLSTATE,
  type SodTableSpec,
} from './db.js';
export {
  APPROVER_ROLES,
  assertCanApprove,
  assertDifferentActors,
  assertMinApprovers,
  canApprove,
  SERVICE_ROLES,
} from './primitives.js';
export {
  SOD_VIOLATION_LOG_MESSAGE,
  SOD_VIOLATION_METRIC,
  SOD_VIOLATION_METRIC_LABELS,
  SOD_VIOLATION_REASONS,
  SodViolationError,
  type SodViolationReason,
} from './error.js';
export type { SodOptions, SodWarnSink } from './sink.js';
