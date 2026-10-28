export { SignupController } from './controller.js';
export { InMemorySignupStore, type MemoryAuditEvent, type MemorySignup } from './memory.js';
export { createSignupMetrics, type SignupMetrics } from './metrics.js';
export { SignupModule, type SignupModuleOptions } from './module.js';
export { signupOpenApiModule } from './openapi.js';
export { PostgresSignupStore, type PostgresSignupStoreDeps } from './postgres-store.js';
export type {
  PendingSignup,
  RequestThrottle,
  SignupStore,
  TenantProvisioningQueue,
  TenantProvisioningRequest,
  VerifySignupInput,
  VerifySignupOutcome,
} from './ports.js';
export { SignupService, type SignupServiceDeps } from './service.js';
export { slugBase, slugCandidate } from './slug.js';
export { hashSignupToken, logRef, newSignupToken } from './token.js';
