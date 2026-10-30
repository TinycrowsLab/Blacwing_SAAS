/** Workspace package name of this package. */
export const name = '@blackwing/reporting';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  assembleReport,
  assembleReportFromSource,
  type AssembleReportOptions,
  type AssembleReportSourceOptions,
} from './assemble.js';
export { type ReportAssembleResult, type ReportMetrics, noopReportMetrics } from './telemetry.js';
