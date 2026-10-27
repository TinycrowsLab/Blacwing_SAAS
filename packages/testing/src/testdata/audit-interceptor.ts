// Workflow interceptor module used to prove the harness registers interceptors. It reports each workflow
// execution through a sink, the same way the project's audit interceptor reports through a local activity.
// Bundled into the workflow sandbox: it imports only `@temporalio/workflow`.
import {
  proxySinks,
  workflowInfo,
  type Sinks,
  type WorkflowInterceptorsFactory,
} from '@temporalio/workflow';

export interface AuditCaptureSinks extends Sinks {
  readonly audit: {
    record(kind: 'started' | 'completed' | 'failed', workflowType: string): void;
  };
}

export const interceptors: WorkflowInterceptorsFactory = () => {
  const { audit } = proxySinks<AuditCaptureSinks>();
  return {
    inbound: [
      {
        async execute(input, next) {
          const { workflowType } = workflowInfo();
          audit.record('started', workflowType);
          try {
            const result = await next(input);
            audit.record('completed', workflowType);
            return result;
          } catch (error) {
            audit.record('failed', workflowType);
            throw error;
          }
        },
      },
    ],
  };
};
