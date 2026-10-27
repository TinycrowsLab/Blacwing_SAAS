/** Workspace package name of this package. */
export const name = '@blackwing/telemetry';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  createWorkflowContext,
  findWorkflowContext,
  getActivityContext,
  runWithWorkflowContext,
  type WorkflowContextInit,
} from './context.js';
