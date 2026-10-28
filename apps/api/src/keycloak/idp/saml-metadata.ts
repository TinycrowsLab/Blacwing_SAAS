import { X509Certificate } from 'node:crypto';

import { ValidationError } from '@blackwing/errors';

import { childrenNamed, descendantsNamed, parseXmlSafely, type XmlElement } from './xml.js';

/**
 * SAML 2.0 metadata for the per-org SAML provider (IAM-004). It reads the identity provider's metadata (entityID,
 * SSO and SLO endpoints, signing certificates) and the service-provider descriptor that Keycloak publishes for the
 * customer to register. Parsing is XXE-safe (see `xml.ts`). Signature validation of assertions is enforced by
 * Keycloak (`wantAssertionsSigned`); this module only decides which metadata is acceptable.
 */

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const SAML_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const MAX_ENTITY_ID = 1024;
const MS_PER_DAY = 86_400_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

type SamlBinding = 'post' | 'redirect';

interface SamlEndpoint {
  readonly url: string;
  readonly binding: SamlBinding;
}

/** A signing certificate, as Keycloak takes it: base64 DER, without PEM headers. */
export interface SamlSigningCertificate {
  readonly der: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly fingerprint256: string;
}

export interface SamlIdpMetadata {
  readonly entityId: string;
  readonly sso: SamlEndpoint;
  readonly slo?: SamlEndpoint;
  /** Only certificates valid at the time of parsing. Expired and not-yet-valid certificates are dropped. */
  readonly signingCertificates: readonly SamlSigningCertificate[];
}

export interface SamlSpDescriptor {
  readonly entityId: string;
  readonly acs: SamlEndpoint;
}

/** Prefers HTTP-POST, then HTTP-Redirect; anything else is not a binding Blackwing configures. */
function pickEndpoint(elements: readonly XmlElement[], what: string): SamlEndpoint | undefined {
  const usable = elements.flatMap((element): SamlEndpoint[] => {
    const location = element.attributes.get('Location');
    const binding = element.attributes.get('Binding');
    if (location === undefined) return [];
    if (binding === BINDING_POST) return [{ url: location, binding: 'post' }];
    if (binding === BINDING_REDIRECT) return [{ url: location, binding: 'redirect' }];
    return [];
  });
  const endpoint = usable.find((item) => item.binding === 'post') ?? usable[0];
  if (endpoint === undefined) return undefined;
  if (!httpsOnly(endpoint.url)) {
    throw new ValidationError(`The SAML ${what} is not https`, {
      detail: `the ${what} location must be an https URL`,
    });
  }
  return endpoint;
}

function httpsOnly(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Decodes one X.509 certificate. A malformed certificate is a validation failure, never silently skipped. */
function parseCertificate(base64: string): {
  readonly der: string;
  readonly cert: X509Certificate;
} {
  const der = base64.replace(/\s+/g, '');
  if (!BASE64.test(der)) {
    throw new ValidationError('A SAML signing certificate is malformed', {
      detail: 'the signing certificate is not base64',
    });
  }
  try {
    return { der, cert: new X509Certificate(Buffer.from(der, 'base64')) };
  } catch {
    throw new ValidationError('A SAML signing certificate is malformed', {
      detail: 'the signing certificate is not an X.509 certificate',
    });
  }
}

function toSigningCertificate(der: string, cert: X509Certificate): SamlSigningCertificate {
  return {
    der,
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
    fingerprint256: cert.fingerprint256,
  };
}

/** The signing keys of a descriptor: KeyDescriptors with use "signing" or no use. */
function signingCertificatesOf(element: XmlElement, now: Date): SamlSigningCertificate[] {
  const keys = childrenNamed(element, MD, 'KeyDescriptor').filter((key) => {
    const use = key.attributes.get('use');
    return use === undefined || use === 'signing';
  });
  const certificates = keys.flatMap((key) =>
    descendantsNamed(key, DS, 'X509Certificate').map((node) => parseCertificate(node.text)),
  );
  return certificates
    .map(({ der, cert }) => toSigningCertificate(der, cert))
    .filter(
      (cert) =>
        cert.notBefore.getTime() <= now.getTime() && now.getTime() < cert.notAfter.getTime(),
    );
}

/**
 * Parses an identity provider's SAML metadata. Refuses: anything but one EntityDescriptor with an
 * IDPSSODescriptor, expired metadata (`validUntil`), a non-SAML2 protocol, an SSO endpoint that is not https, and
 * a document with no currently valid signing certificate (fail closed: an unsigned or unverifiable provider is
 * never configured).
 */
export function parseIdpMetadata(xml: string, now: Date): SamlIdpMetadata {
  const root = parseXmlSafely(xml);
  if (root.uri !== MD || root.local !== 'EntityDescriptor') {
    throw new ValidationError('The SAML metadata is not a single EntityDescriptor', {
      detail: 'upload the metadata of one identity provider (EntityDescriptor), not an aggregate',
    });
  }
  const validUntil = root.attributes.get('validUntil');
  if (validUntil !== undefined && new Date(validUntil).getTime() <= now.getTime()) {
    throw new ValidationError('The SAML metadata has expired', {
      detail:
        'the metadata validUntil time has passed; obtain current metadata from the identity provider',
    });
  }
  const entityId = root.attributes.get('entityID') ?? '';
  if (entityId === '' || entityId.length > MAX_ENTITY_ID) {
    throw new ValidationError('The SAML metadata has no usable entityID', {
      detail: `entityID must be present and at most ${MAX_ENTITY_ID} characters`,
    });
  }
  const idp = childrenNamed(root, MD, 'IDPSSODescriptor')[0];
  if (idp === undefined) {
    throw new ValidationError('The SAML metadata has no identity provider descriptor', {
      detail: 'the metadata must contain an IDPSSODescriptor',
    });
  }
  const protocols = (idp.attributes.get('protocolSupportEnumeration') ?? '').split(/\s+/);
  if (!protocols.includes(SAML_PROTOCOL)) {
    throw new ValidationError('The identity provider does not support SAML 2.0', {
      detail: 'the IDPSSODescriptor must list the SAML 2.0 protocol',
    });
  }
  const sso = pickEndpoint(childrenNamed(idp, MD, 'SingleSignOnService'), 'single sign-on service');
  if (sso === undefined) {
    throw new ValidationError('The SAML metadata has no usable single sign-on service', {
      detail: 'the metadata needs an HTTP-POST or HTTP-Redirect SingleSignOnService',
    });
  }
  const slo = pickEndpoint(childrenNamed(idp, MD, 'SingleLogoutService'), 'single logout service');
  const signingCertificates = signingCertificatesOf(idp, now);
  if (signingCertificates.length === 0) {
    throw new ValidationError('The SAML metadata has no currently valid signing certificate', {
      detail: 'add a signing certificate that is within its validity period',
    });
  }
  return {
    entityId,
    sso,
    ...(slo === undefined ? {} : { slo }),
    signingCertificates,
  };
}

/** Reads the service-provider descriptor that Keycloak publishes for a SAML provider (the customer registers it). */
export function parseSpDescriptor(xml: string): SamlSpDescriptor {
  const root = parseXmlSafely(xml);
  if (root.uri !== MD || root.local !== 'EntityDescriptor') {
    throw new ValidationError('The service-provider metadata is not an EntityDescriptor', {
      detail: 'Keycloak returned an unexpected service-provider descriptor',
    });
  }
  const entityId = root.attributes.get('entityID') ?? '';
  const sp = childrenNamed(root, MD, 'SPSSODescriptor')[0];
  const acs =
    sp === undefined
      ? undefined
      : pickEndpoint(
          childrenNamed(sp, MD, 'AssertionConsumerService'),
          'assertion consumer service',
        );
  if (entityId === '' || acs === undefined) {
    throw new ValidationError('The service-provider metadata has no assertion consumer service', {
      detail: 'Keycloak returned an unexpected service-provider descriptor',
    });
  }
  return { entityId, acs };
}

/** Whole days until `notAfter`, rounded down. Negative once expired. */
export function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - now.getTime()) / MS_PER_DAY);
}
