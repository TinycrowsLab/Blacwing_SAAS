import { ApiProblemError } from '../errors/problem-errors.js';
import { problemRegistry } from '../errors/registry.js';

/** Wire code of a submit against a halted tenant (§8.4). Registry codes are lower snake_case (§9). */
const TENANT_HALTED_CODE = 'tenant_halted';

problemRegistry.register(TENANT_HALTED_CODE, { status: 409, title: 'Tenant is halted' });

export function tenantHaltedError(): ApiProblemError {
  return new ApiProblemError(TENANT_HALTED_CODE, 'the tenant is halted', {
    detail: 'The kill switch is active for this tenant: no assessment request can be submitted.',
  });
}
