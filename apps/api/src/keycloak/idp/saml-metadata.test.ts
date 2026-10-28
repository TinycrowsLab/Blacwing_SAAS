import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import {
  ACS_URL,
  EXPIRED_CERT_B64,
  idpMetadataXml,
  NOW,
  SP_ENTITY_ID,
  spDescriptorXml,
  VALID_CERT_B64,
} from './fixtures.test-helpers.js';
import { daysUntil, parseIdpMetadata, parseSpDescriptor } from './saml-metadata.js';

const FUTURE = '2027-01-01T00:00:00Z';
const PAST = '2026-01-01T00:00:00Z';
const SSO_POST = 'https://idp.example.test/sso';

describe('parseIdpMetadata', () => {
  it('reads the entityID, the preferred SSO binding, the SLO endpoint and the valid signing certificate', () => {
    const parsed = parseIdpMetadata(idpMetadataXml({ validUntil: FUTURE }), NOW);
    expect(parsed.entityId).toBe('https://idp.example.test/saml');
    expect(parsed.sso).toEqual({ url: SSO_POST, binding: 'post' });
    expect(parsed.slo).toEqual({ url: 'https://idp.example.test/slo', binding: 'redirect' });
    expect(parsed.signingCertificates).toHaveLength(1);
    const [cert] = parsed.signingCertificates;
    expect(cert?.der).toBe(VALID_CERT_B64);
    expect(cert?.notAfter.toISOString()).toBe('2126-01-01T00:00:00.000Z');
    expect(cert?.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('falls back to HTTP-Redirect when no POST SSO endpoint exists', () => {
    const xml = idpMetadataXml().replace(
      /<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"[^>]*\/>/,
      '',
    );
    expect(parseIdpMetadata(xml, NOW).sso).toEqual({
      url: 'https://idp.example.test/sso-redirect',
      binding: 'redirect',
    });
  });

  it('omits the SLO endpoint when the metadata has none', () => {
    const xml = idpMetadataXml().replace(/<md:SingleLogoutService[^>]*\/>/, '');
    expect(parseIdpMetadata(xml, NOW)).not.toHaveProperty('slo');
  });

  it('keeps only the currently valid certificates when rolling over (multiple signing certs)', () => {
    const parsed = parseIdpMetadata(
      idpMetadataXml({ certs: [EXPIRED_CERT_B64, VALID_CERT_B64] }),
      NOW,
    );
    expect(parsed.signingCertificates.map((cert) => cert.der)).toEqual([VALID_CERT_B64]);
  });

  it('refuses metadata when every signing certificate is expired', () => {
    expect(() => parseIdpMetadata(idpMetadataXml({ certs: [EXPIRED_CERT_B64] }), NOW)).toThrow(
      /no currently valid signing certificate/,
    );
  });

  it('refuses metadata with no signing key at all (fail closed: never configure an unverifiable IdP)', () => {
    const xml = idpMetadataXml().replace(/<md:KeyDescriptor[\s\S]*?<\/md:KeyDescriptor>/g, '');
    expect(() => parseIdpMetadata(xml, NOW)).toThrow(ValidationError);
  });

  it('refuses a malformed signing certificate rather than skipping it', () => {
    const xml = idpMetadataXml({ certs: ['not$base64!'] });
    expect(() => parseIdpMetadata(xml, NOW)).toThrow(/malformed/);
  });

  it('refuses a base64 value that is not an X.509 certificate', () => {
    const xml = idpMetadataXml({ certs: ['aGVsbG8gd29ybGQ='] });
    expect(() => parseIdpMetadata(xml, NOW)).toThrow(/malformed/);
  });

  it('refuses expired metadata (validUntil in the past)', () => {
    expect(() => parseIdpMetadata(idpMetadataXml({ validUntil: PAST }), NOW)).toThrow(
      /has expired/,
    );
  });

  it('refuses an aggregate EntitiesDescriptor: one identity provider per upload', () => {
    expect(() => parseIdpMetadata(idpMetadataXml({ root: 'EntitiesDescriptor' }), NOW)).toThrow(
      /single EntityDescriptor/,
    );
  });

  it('refuses a provider that does not speak SAML 2.0', () => {
    expect(() =>
      parseIdpMetadata(idpMetadataXml({ protocol: 'urn:oasis:names:tc:SAML:1.1:protocol' }), NOW),
    ).toThrow(/does not support SAML 2.0/);
  });

  it('refuses an SSO endpoint that is not https', () => {
    expect(() =>
      parseIdpMetadata(idpMetadataXml({ ssoLocation: 'http://idp.example.test/sso' }), NOW),
    ).toThrow(/not https/);
  });

  it('refuses metadata with no usable SSO binding', () => {
    const soapOnly = idpMetadataXml({
      ssoBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:SOAP',
    }).replace(
      /<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"[^>]*\/>/,
      '',
    );
    expect(() => parseIdpMetadata(soapOnly, NOW)).toThrow(/no usable single sign-on service/);
  });

  it('refuses metadata without an entityID', () => {
    expect(() => parseIdpMetadata(idpMetadataXml({ entityId: '' }), NOW)).toThrow(
      /no usable entityID/,
    );
  });

  it('refuses an entityID longer than 1024 characters', () => {
    expect(() => parseIdpMetadata(idpMetadataXml({ entityId: 'e'.repeat(1025) }), NOW)).toThrow(
      /no usable entityID/,
    );
  });

  it('refuses a DTD with an external entity (XXE, CWE-611) before reading anything else', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE EntityDescriptor [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="&x;"></md:EntityDescriptor>`;
    expect(() => parseIdpMetadata(xxe, NOW)).toThrow(/declares a DTD or entities/);
  });

  it('refuses metadata with no identity provider descriptor', () => {
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/></md:EntityDescriptor>`;
    expect(() => parseIdpMetadata(xml, NOW)).toThrow(/no identity provider descriptor/);
  });

  it('refuses oversized metadata before parsing it', () => {
    const xml = `${idpMetadataXml()}${'<!-- pad -->'.repeat(30_000)}`;
    expect(() => parseIdpMetadata(xml, NOW)).toThrow(/too large/);
  });
});

describe('parseSpDescriptor', () => {
  it('reads the service-provider entityID and the POST assertion consumer service', () => {
    expect(parseSpDescriptor(spDescriptorXml())).toEqual({
      entityId: SP_ENTITY_ID,
      acs: { url: ACS_URL, binding: 'post' },
    });
  });

  it('refuses a descriptor with no assertion consumer service', () => {
    expect(() => parseSpDescriptor(spDescriptorXml({ omitAcs: true }))).toThrow(
      /no assertion consumer service/,
    );
  });

  it('refuses an unexpected root element', () => {
    expect(() => parseSpDescriptor('<html/>')).toThrow(/not an EntityDescriptor/);
  });
});

describe('daysUntil', () => {
  it('counts whole days, negative once passed', () => {
    expect(daysUntil(new Date('2026-11-27T12:00:00Z'), NOW)).toBe(30);
    expect(daysUntil(new Date('2026-10-27T12:00:00Z'), NOW)).toBe(-1);
  });
});
