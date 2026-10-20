import { ProviderError } from './errors.js';

/**
 * A resolved provider credential. `subscription_session` models a claude.ai login (subscription/OAuth
 * session), which must never power customer runs (CONTEXT_PACK §4.5); it exists so the guard can refuse it.
 */
export type ProviderCredential =
  | { readonly kind: 'api_key'; readonly apiKey: string }
  | { readonly kind: 'subscription_session'; readonly token: string };

/**
 * The credential seam. GATEWAY-007 injects the OpenBao-backed, per-tenant implementation; the secret is
 * read at call time and never placed in logs or responses (§8.7).
 */
export type ResolveProviderCredential = (
  tenantId: string | undefined,
) => Promise<ProviderCredential>;

/** Prefixes of claude.ai subscription/OAuth tokens and session artefacts, never valid as an API key. */
const SUBSCRIPTION_STYLE_PREFIXES = ['sk-ant-oat', 'sk-ant-ort', 'sessionkey=', 'bearer '] as const;

const API_KEY_MIN_LENGTH = 8;

/**
 * OFFLINE-STUB(online-porting #884): dev/test resolve one static key from gateway config for every tenant;
 * production reads per-tenant credentials from OpenBao (GATEWAY-007).
 */
export function staticApiKeyResolver(apiKey: string | undefined): ResolveProviderCredential {
  const credential: ProviderCredential = { kind: 'api_key', apiKey: apiKey ?? '' };
  return () => Promise.resolve(credential);
}

/**
 * Hard guard of §4.5: only a Developer Platform API key is accepted. Returns the key, or throws
 * `PROVIDER_CRED_UNSUPPORTED` (subscription-style) / `PROVIDER_CRED_MISSING` (no key). The message never
 * includes the credential.
 */
export function requireApiKey(credential: ProviderCredential): string {
  if (credential.kind !== 'api_key') {
    throw unsupported();
  }
  const key = credential.apiKey;
  if (key.length === 0) {
    throw new ProviderError({
      code: 'PROVIDER_CRED_MISSING',
      httpStatus: 503,
      errorType: 'api_error',
      message: 'No provider credential is configured for this tenant.',
      retryable: false,
    });
  }
  const lowered = key.trim().toLowerCase();
  if (
    key.length < API_KEY_MIN_LENGTH ||
    SUBSCRIPTION_STYLE_PREFIXES.some((prefix) => lowered.startsWith(prefix))
  ) {
    throw unsupported();
  }
  return key;
}

function unsupported(): ProviderError {
  return new ProviderError({
    code: 'PROVIDER_CRED_UNSUPPORTED',
    httpStatus: 403,
    errorType: 'permission_error',
    message:
      'Subscription-style credentials are not supported; configure an Anthropic API key or a cloud provider credential.',
    retryable: false,
  });
}
