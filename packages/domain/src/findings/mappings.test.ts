import { describe, expect, it } from 'vitest';

import { DEFAULT_MAPPING_DATASET } from './mappings.js';
import { WEBAPI_CATALOGUE } from '../testcases/webapi.js';

// The shipped dataset must describe every catalogued test class, with the refs the catalogue declares. The
// mapping is derived from the catalogue, so a catalogue change that is not mirrored here fails this test.
describe('shipped mapping dataset (1.0.0) against the web/API catalogue', () => {
  it('maps every catalogued class and no other class', () => {
    const catalogued = WEBAPI_CATALOGUE.entries.map((entry) => entry.id).sort();
    expect(Object.keys(DEFAULT_MAPPING_DATASET.mappings).sort()).toEqual(catalogued);
  });

  it.each(WEBAPI_CATALOGUE.entries.map((entry) => [entry.id, entry] as const))(
    '%s agrees with the catalogue refs',
    (id, entry) => {
      const mapping = DEFAULT_MAPPING_DATASET.mappings[id];
      expect(mapping).toBeDefined();
      expect(mapping?.cweCandidates).toEqual(entry.cwe);
      expect(mapping?.wstg).toEqual(entry.wstg);
      expect(mapping?.apiTop10).toBe(entry.apiTop10?.[0]);
      // Primary OWASP category is the first catalogued one; an API-only class falls back to A01.
      expect(mapping?.owaspTop10).toBe(entry.owasp[0] ?? 'A01');
    },
  );

  it('gives an API-only class the A01 fallback and an API Top 10 id', () => {
    const entry = WEBAPI_CATALOGUE.entries.find((candidate) => candidate.owasp.length === 0);
    expect(entry).toBeDefined();
    expect(DEFAULT_MAPPING_DATASET.mappings[entry?.id ?? '']).toMatchObject({
      owaspTop10: 'A01',
      apiTop10: 'API3',
    });
  });
});
