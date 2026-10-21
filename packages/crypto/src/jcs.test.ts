import { describe, expect, it } from 'vitest';

import { jcs } from './jcs.js';

describe('jcs (RFC 8785)', () => {
  it('sorts members recursively and drops whitespace', () => {
    expect(jcs({ b: 1, a: { d: [3, { z: null, y: true }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}',
    );
  });

  it('sorts by UTF-16 code units (RFC 8785 section 3.2.3)', () => {
    expect(jcs({ '€': 1, '😀': 2, a: 3 })).toBe('{"a":3,"€":1,"😀":2}');
  });

  it('serialises numbers and strings like ECMAScript', () => {
    expect(jcs([1e21, 0.000001, -0, 1.5, 'a"\n\u0001'])).toBe(
      '[1e+21,0.000001,0,1.5,"a\\"\\n\\u0001"]',
    );
  });

  it('omits undefined members and is key-order independent', () => {
    expect(jcs({ a: 1, b: undefined })).toBe(jcs({ a: 1 }));
    expect(jcs({ x: 1, y: 2 })).toBe(jcs({ y: 2, x: 1 }));
  });

  it('rejects values with no canonical JSON form', () => {
    expect(() => jcs(Number.NaN)).toThrow(TypeError);
    expect(() => jcs(Infinity)).toThrow(TypeError);
    expect(() => jcs(10n)).toThrow(TypeError);
    expect(() => jcs(new Date())).toThrow(TypeError);
    expect(() => jcs(undefined)).toThrow(TypeError);
  });
});
