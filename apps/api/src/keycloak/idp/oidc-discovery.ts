import { z } from 'zod';

import { ValidationError } from '@blackwing/errors';

import { type FetchLike, fetchBoundedText, requirePublicHttpsUrl } from './bounded-fetch.js';

/**
 * Generic OIDC discovery for an organisation's identity provider (IAM-004). The issuer's well-known document is
 * fetched, bounded and validated before any of its endpoints is written to Keycloak. A document that does not
 * describe the configured issuer, or that does not support the authorization code flow with PKCE (S256), is refused.
 */

const MAX_DISCOVERY_BYTES = 65_536;
const WELL_KNOWN = '/.well-known/openid-configuration';

const discoverySchema = z.looseObject({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  jwks_uri: z.string().min(1),
  userinfo_endpoint: z.string().min(1).optional(),
  response_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly userinfoEndpoint?: string;
}

/** The issuer without a trailing slash, so `https://x/` and `https://x` compare equal. */
export function normaliseIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

/** Discovers the issuer's endpoints. Unreachable or 5xx is retryable; a bad document is a validation failure. */
export async function discoverOidc(
  issuerInput: string,
  options: { readonly fetch: FetchLike; readonly timeoutMs: number },
): Promise<OidcDiscovery> {
  const issuer = normaliseIssuer(issuerInput);
  const url = requirePublicHttpsUrl(`${issuer}${WELL_KNOWN}`, 'The issuer URL');
  const body = await fetchBoundedText({
    fetch: options.fetch,
    url: url.toString(),
    accept: 'application/json',
    maxBytes: MAX_DISCOVERY_BYTES,
    timeoutMs: options.timeoutMs,
  });

  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    throw new ValidationError('The OIDC discovery document is not JSON', {
      detail: 'the issuer well-known document could not be parsed',
    });
  }
  const parsed = discoverySchema.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError('The OIDC discovery document is incomplete', {
      detail: 'the document must carry issuer, authorization_endpoint, token_endpoint and jwks_uri',
    });
  }
  const doc = parsed.data;
  if (normaliseIssuer(doc.issuer) !== issuer) {
    throw new ValidationError('The OIDC discovery issuer does not match', {
      detail: 'the issuer in the discovery document must equal the configured issuer',
    });
  }
  if (
    doc.response_types_supported !== undefined &&
    !doc.response_types_supported.includes('code')
  ) {
    throw new ValidationError('The OIDC provider does not support the authorization code flow', {
      detail: 'the provider must advertise the code response type',
    });
  }
  if (
    doc.code_challenge_methods_supported !== undefined &&
    !doc.code_challenge_methods_supported.includes('S256')
  ) {
    throw new ValidationError('The OIDC provider does not support PKCE with S256', {
      detail: 'the provider must advertise S256 code challenges',
    });
  }
  const authorizationEndpoint = requirePublicHttpsUrl(
    doc.authorization_endpoint,
    'The authorization endpoint',
  ).toString();
  const tokenEndpoint = requirePublicHttpsUrl(doc.token_endpoint, 'The token endpoint').toString();
  const jwksUri = requirePublicHttpsUrl(doc.jwks_uri, 'The JWKS URI').toString();
  const userinfoEndpoint =
    doc.userinfo_endpoint === undefined
      ? undefined
      : requirePublicHttpsUrl(doc.userinfo_endpoint, 'The userinfo endpoint').toString();
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    ...(userinfoEndpoint === undefined ? {} : { userinfoEndpoint }),
  };
}
