// Activity registration surface (WORKFLOW-002). ORCH, SCHED and the other epics add their activities
// to this object; it starts empty so the worker boots with nothing to run.

/** Activities registered on every worker. */
export const activities: Record<string, (...args: never[]) => Promise<unknown>> = {};
