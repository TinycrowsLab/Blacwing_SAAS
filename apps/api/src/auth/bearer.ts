import { AuthInvalidTokenError } from './errors.js';

import type { Principal } from '@blackwing/contracts';

/**
 * The validator for opaque `bw_pat_` / `bw_ci_` tokens. It is owned by RBAC-007, which wires its implementation
 * here. This guard only detects the prefix and delegates; it never hashes or looks up `api_tokens`.
 */
export interface BearerTokenValidator {
  validate(token: string): Promise<Principal>;
}

/**
 * The default until RBAC-007 is wired: opaque tokens are refused (fail closed), never accepted by a guess.
 */
export const UNCONFIGURED_BEARER_VALIDATOR: BearerTokenValidator = {
  validate: () => {
    throw new AuthInvalidTokenError('opaque bearer tokens are not accepted by this deployment');
  },
};
