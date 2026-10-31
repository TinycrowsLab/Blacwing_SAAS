/** Workspace package name of this package. */
export const name = '@blackwing/cost';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  type CostAggregates,
  type CostTotals,
  createCostAggregates,
  type MonthWindow,
  monthWindow,
  type PersonaCost,
  type RunCost,
  type StageCost,
  type TenantMonthCost,
  type TimeZoneSource,
} from './aggregate.js';
