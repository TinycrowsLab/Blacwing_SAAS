// Workflow bundle entry (WORKFLOW-002). This graph is bundled for the deterministic workflow sandbox:
// import only `@temporalio/workflow` and pure modules here, never Node built-ins or the client.
// ORCH and SCHED add their workflows by re-exporting them from this file.

export { AgentSessionWorkflow } from './agent-session.workflow.js';
export { KillPropagationWorkflow } from './kill-propagation.js';
export { PostExecutionWorkflow } from './post-execution.js';
export { PreflightWorkflow } from './preflight.js';
export { SaTimeBoundsWorkflow } from './sa-time-bounds.js';

/** Trivial workflow proving the worker end to end. It is not a product workflow. */
export function noopWorkflow(): Promise<void> {
  return Promise.resolve();
}
