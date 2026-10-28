import { describe, expect, it } from 'vitest';

import { canonicalQueryText } from '@blackwing/contracts';

import {
  buildManifest,
  extractOperationTexts,
  rotateGenerations,
  serializeGenerations,
  serializeManifest,
} from './persist.js';
import {
  persistedHash,
  PERSISTED_PREVIOUS_GENERATIONS,
  type PersistedManifest,
} from './persisted.js';

const RUNS = 'query Runs { runs { id } }';

describe('extractOperationTexts', () => {
  it('reads defineQuery calls with a string literal, a template literal or a top-level const', () => {
    const texts = extractOperationTexts([
      {
        fileName: 'apps/web/src/a.ts',
        text: [
          "const CONST_QUERY = 'query Named { named { id } }';",
          `export const a = defineQuery<A>('${RUNS}');`,
          'export const b = defineQuery<B>(`query Tpl { tpl { id } }`);',
          'export const c = defineQuery<C>(CONST_QUERY);',
        ].join('\n'),
      },
    ]);
    expect(texts).toEqual([RUNS, 'query Tpl { tpl { id } }', 'query Named { named { id } }']);
  });

  it('fails the build on a defineQuery argument it cannot read, so it cannot slip past the manifest', () => {
    const dynamic = [
      { fileName: 'apps/web/src/b.ts', text: 'const q = build();\ndefineQuery(q);' },
    ];
    expect(() => extractOperationTexts(dynamic)).toThrow(
      /apps\/web\/src\/b\.ts:2: defineQuery needs/,
    );
    const templated = [
      { fileName: 'x.ts', text: 'const n = 1;\ndefineQuery(`query { a${"n"} }`);' },
    ];
    expect(() => extractOperationTexts(templated)).toThrow(/x\.ts:2/);
  });

  it('ignores files without defineQuery and calls to other functions', () => {
    expect(extractOperationTexts([{ fileName: 'c.ts', text: "other('query X { x }');" }])).toEqual(
      [],
    );
  });
});

describe('buildManifest', () => {
  it('keys each canonical text by its hash, and sorts by hash so the file is stable', () => {
    const manifest = buildManifest([RUNS, 'query Users { users { id } }']);
    expect([...manifest.keys()]).toEqual([...manifest.keys()].sort());
    expect(manifest.get(persistedHash(RUNS))).toBe(canonicalQueryText(RUNS));
  });

  it('gives the same manifest for two layouts of one document (the drift gate is layout-blind)', () => {
    const spread = 'query Runs {\n  runs {\n    id\n  }\n}';
    expect(serializeManifest(buildManifest([spread]))).toBe(
      serializeManifest(buildManifest([RUNS])),
    );
  });

  it('serialises as sorted JSON with a trailing newline', () => {
    expect(serializeManifest(buildManifest([]))).toBe('{}\n');
    expect(serializeManifest(buildManifest([RUNS]))).toMatch(
      /^\{\n {2}"[0-9a-f]{64}": "query Runs/,
    );
  });
});

describe('rotateGenerations', () => {
  const generation = (name: string): PersistedManifest => {
    const text = `query ${name} { ${name} { id } }`;
    return new Map([[persistedHash(text), text]]);
  };
  const texts = (manifest: PersistedManifest): string[] => [...manifest.values()];

  it('moves the outgoing manifest to the front and keeps only the grace window', () => {
    const kept = rotateGenerations(generation('Fresh'), [
      generation('Older'),
      generation('Oldest'),
    ]);
    expect(kept).toHaveLength(PERSISTED_PREVIOUS_GENERATIONS);
    expect(kept.map((manifest) => texts(manifest))).toEqual([
      texts(generation('Fresh')),
      texts(generation('Older')),
    ]);
  });

  it('does not keep an empty outgoing manifest as a generation', () => {
    expect(rotateGenerations(new Map(), [generation('Older')])).toHaveLength(1);
  });

  it('serialises generations as a JSON array of manifests', () => {
    expect(serializeGenerations([])).toBe('[]\n');
    expect(JSON.parse(serializeGenerations([generation('Runs')]))).toEqual([
      { [persistedHash('query Runs { Runs { id } }')]: 'query Runs { Runs { id } }' },
    ]);
  });
});
