// Fixtures for the per-org identity provider tests (IAM-004). The certificates are public test certificates with
// fixed validity windows (2026 to 2126, and an expired 2020 to 2021 one); their private keys are not kept.
// OFFLINE-STUB(online-porting #904): the SAML and OIDC flows run against fake endpoints here. Port the end-to-end
// checks to the dev Keycloak with a mock IdP.

export const NOW = new Date('2026-10-28T12:00:00Z');
export const VALID_CERT_B64 =
  'MIIDJTCCAg2gAwIBAgIUe8LA7tInkIc3cQp4hu/g/QGcv3EwDQYJKoZIhvcNAQELBQAwITEfMB0GA1UEAwwWaWRwLXZhbGlkLmV4YW1wbGUudGVzdDAgFw0yNjAxMDEwMDAwMDBaGA8yMTI2MDEwMTAwMDAwMFowITEfMB0GA1UEAwwWaWRwLXZhbGlkLmV4YW1wbGUudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANK/anI7EvNtajl7szXm5Pxj4x3eIvlADrIo9bFKFx3HLG7AQD9ktGY6XZUkic5uyjPd/MHf98vR3+7sq6JcMHnWCf8RCmqNY6+v9gdRRZRzGtZDyVZyivlSEhFEwKV8R5h3tDcfcDcBYNTteyr2gD1AII+kpldeGhOe4pKVv9XuMWrebYGpp/55T7X0kP7/Zw5WcQ25Xavz3Tjnvw1J1y3hnsuqbMJiEee3FNjBO6+tEe6SZSpFSlW0om58F8Vdt8s89ws171Q97QJMibaaIp0QXzqu6OeTDLHCwrSxWythZpNu+Dz4mhgaLmWD6Um9pe0TR/PqvS4SgRnRh5h1MVECAwEAAaNTMFEwHQYDVR0OBBYEFF3f8P/CJUShGCW9+mR1Y/e0WGmYMB8GA1UdIwQYMBaAFF3f8P/CJUShGCW9+mR1Y/e0WGmYMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAM4uyVM9QV9589l7qwRcKOrDePuns2lfC+WrMXMoRwAACi8OSnqmVNxYCRckkzLYFVKASf0uiQiRQw++Y7ayZ51/ai7S+Fn0qfLy4hYMOuZmr4z5B9SE9UcREAtyrMyvS39N7CJ3a8hXrsoJkHf1LpDZsfaJhrg7RQn9DCUYAAFauvm7rFApqqUAExLfmA+6TFORng85K3uuSiBHCuvSGAaQo9SqIGUk1KsSTJ9p4dpik3VzzbknV5S9MWoMbPQWKs4IXEzhOR0p1wgUH00euOk5Hgu6xdQfC5HmlDI5OWVovET+fi4fJSTTJH7jxDd6OYvJYI9BmB9+mcOqWzCGDZo=';
export const EXPIRED_CERT_B64 =
  'MIIDHzCCAgegAwIBAgIUSRPdGZCoSJ+ZQ3l6pbMiyRTV/acwDQYJKoZIhvcNAQELBQAwHzEdMBsGA1UEAwwUaWRwLW9sZC5leGFtcGxlLnRlc3QwHhcNMjAwMTAxMDAwMDAwWhcNMjEwMTAxMDAwMDAwWjAfMR0wGwYDVQQDDBRpZHAtb2xkLmV4YW1wbGUudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAML9AOstpR0XNZN3QocnCHckRmTFvtXvGF84OsqNeXYdXQNMxvtPWLCrtPn5Q1lO6XbbCCg8bZycP7Vq4Gy7M2R/oshNFdnAcPNIvB4EiuRUSx9mLz8UlTslY6bFNs/r4cJTP6k1b0UIByb4CNiDYp5GP+VCzCbzUnc6kos0XbTnZuYIsyI3uW3osUryqfBqikWcRmRC7pdQIafgBk3z8kL773uVcAbUhLmw2TP9pL2nG2KM9Troc42j27et1ISZAux+yxaWaT1b0X9uukbo+AuIk3eOvS8PjEg3c5F/1T2wneJvpdPZM16oqoA8kAia4hWb0d+m89rNjR9+sw5cm60CAwEAAaNTMFEwHQYDVR0OBBYEFPf8E8kc/AdaMWbfIFTFlzBTDMB9MB8GA1UdIwQYMBaAFPf8E8kc/AdaMWbfIFTFlzBTDMB9MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAEAm7gCzgthZAkN5+/OGNk3Jh7G+93dE5NVr3w6bW4mAvOD/2fs/DPP5HRAeQkQz/kZ624BONUvHdjaZ7+AsFbvzmQpYIO8PpKk+xPjdOPwxGIosnuUOmDsyrR2l1szGJxJa4n2JjT/AqohJER9HzbV9JKngLJypiagAw7x0cpUaOvZ9MG3qq0EscCuf9v6Dn+oR+fF9Xsclikq5HjJ2HqAot/8klJOU3Im4EUfgXHvbRyVv6YUA7d1bIgg8AtMSI3+JZgpua9i3vHY7qDt5FJOg3bpNWED01zURx+dk+unQqyOAbO7qpRAxGEuMNBe4xyyGa0wSw1lO9zepZd96/cQ=';
export const SP_ENTITY_ID = 'https://id.example.test/realms/blackwing';
export const ACS_URL = 'https://id.example.test/realms/blackwing/broker/acme-saml/endpoint';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const SAML2 = 'urn:oasis:names:tc:SAML:2.0:protocol';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

export interface MetadataOptions {
  readonly certs?: readonly string[];
  readonly validUntil?: string;
  readonly protocol?: string;
  readonly ssoLocation?: string;
  readonly ssoBinding?: string;
  readonly entityId?: string;
  readonly root?: 'EntityDescriptor' | 'EntitiesDescriptor';
}

/** A complete IdP EntityDescriptor. Defaults are valid at NOW. */
export function idpMetadataXml(options: MetadataOptions = {}): string {
  const certs = options.certs ?? [VALID_CERT_B64];
  const keys = certs
    .map(
      (cert) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join('');
  const validUntil = options.validUntil === undefined ? '' : ` validUntil="${options.validUntil}"`;
  const root = options.root ?? 'EntityDescriptor';
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:${root} xmlns:md="${MD}" entityID="${options.entityId ?? 'https://idp.example.test/saml'}"${validUntil}>
<md:IDPSSODescriptor protocolSupportEnumeration="${options.protocol ?? SAML2}">
${keys}
<md:SingleLogoutService Binding="${REDIRECT}" Location="https://idp.example.test/slo"/>
<md:SingleSignOnService Binding="${REDIRECT}" Location="https://idp.example.test/sso-redirect"/>
<md:SingleSignOnService Binding="${options.ssoBinding ?? POST}" Location="${options.ssoLocation ?? 'https://idp.example.test/sso'}"/>
</md:IDPSSODescriptor>
</md:${root}>`;
}

/** The service-provider descriptor Keycloak publishes for a SAML broker. */
export function spDescriptorXml(
  options: { readonly acsLocation?: string; readonly omitAcs?: boolean } = {},
): string {
  const acs = options.omitAcs
    ? ''
    : `<md:AssertionConsumerService Binding="${POST}" Location="${options.acsLocation ?? ACS_URL}" index="1"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${MD}" entityID="${SP_ENTITY_ID}">
<md:SPSSODescriptor protocolSupportEnumeration="${SAML2}">${acs}</md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

/** Builds a `Response`-returning fake fetch from a map of exact URLs. Unknown URLs fail the test loudly. */
export function fakeFetch(routes: Readonly<Record<string, () => Response | Promise<Response>>>) {
  const seen: string[] = [];
  const fn = async (input: string): Promise<Response> => {
    seen.push(input);
    const route = routes[input];
    if (route === undefined) throw new Error(`unexpected fetch: ${input}`);
    return route();
  };
  return { fetch: fn, seen };
}

export const xmlResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/xml' } });

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const OIDC_ISSUER = 'https://idp.example.test';
export const OIDC_DISCOVERY_URL = `${OIDC_ISSUER}/.well-known/openid-configuration`;

/** A discovery document that passes every check the service applies. */
export function discoveryDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer: OIDC_ISSUER,
    authorization_endpoint: `${OIDC_ISSUER}/authorize`,
    token_endpoint: `${OIDC_ISSUER}/token`,
    jwks_uri: `${OIDC_ISSUER}/jwks`,
    userinfo_endpoint: `${OIDC_ISSUER}/userinfo`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  };
}
