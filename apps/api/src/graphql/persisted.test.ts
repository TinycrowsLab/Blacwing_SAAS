import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decidePersisted,
  loadPersistedManifests,
  persistedHash,
  type PersistedManifests,
} from './persisted.js';

import type { Logger } from '@blackwing/logger';

const RUNS = 'query Runs { runs { id } }';
const RUNS_ID = persistedHash(RUNS);
const SECOND = 'query Users { users { id } }';
const SECOND_ID = persistedHash(SECOND);
const RETIRED = 'query Old { old { id } }';
const RETIRED_ID = persistedHash(RETIRED);
const UNKNOWN_ID = 'f'.repeat(64);

const MANIFESTS: PersistedManifests = {
  current: new Map([
    [RUNS_ID, RUNS],
    [SECOND_ID, SECOND],
  ]),
  previous: [new Map([[RETIRED_ID, RETIRED]])],
};
const EMPTY: PersistedManifests = { current: new Map(), previous: [] };

const hashed = (hash: string, extra: Record<string, unknown> = {}) => ({
  extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
  ...extra,
});

describe('decidePersisted (production: persistedOnly)', () => {
  it('resolves a known id to its reviewed text', () => {
    expect(decidePersisted(hashed(RUNS_ID), MANIFESTS, true)).toEqual({
      allow: true,
      hash: RUNS_ID,
      query: RUNS,
    });
  });

  it('accepts an id given as a top-level `id`', () => {
    expect(decidePersisted({ id: RUNS_ID }, MANIFESTS, true)).toMatchObject({
      allow: true,
      query: RUNS,
    });
  });

  it('carries the variables through untouched (only the document is pinned)', () => {
    const decision = decidePersisted(hashed(RUNS_ID, { variables: { limit: 5 } }), MANIFESTS, true);
    expect(decision).toMatchObject({ allow: true, query: RUNS });
  });

  it('refuses an unknown id with persisted_query_not_found', () => {
    expect(decidePersisted(hashed(UNKNOWN_ID), MANIFESTS, true)).toEqual({
      allow: false,
      code: 'persisted_query_not_found',
      hash: UNKNOWN_ID,
    });
  });

  it('refuses a malformed id as not found, never as a manifest lookup', () => {
    expect(decidePersisted(hashed('RUNS'), MANIFESTS, true)).toMatchObject({
      allow: false,
      code: 'persisted_query_not_found',
    });
    expect(decidePersisted(hashed(RUNS_ID.toUpperCase()), MANIFESTS, true)).toMatchObject({
      allow: false,
      code: 'persisted_query_not_found',
    });
  });

  it('refuses a raw query string with persisted_query_required', () => {
    expect(decidePersisted({ query: RUNS }, MANIFESTS, true)).toEqual({
      allow: false,
      code: 'persisted_query_required',
    });
  });

  it('refuses a document sent alongside its hash (no registration in production)', () => {
    expect(decidePersisted(hashed(RUNS_ID, { query: RUNS }), MANIFESTS, true)).toEqual({
      allow: false,
      code: 'persisted_query_required',
      hash: RUNS_ID,
    });
  });

  it('refuses a request with neither a query nor an id', () => {
    expect(decidePersisted({ variables: {} }, MANIFESTS, true)).toEqual({
      allow: false,
      code: 'persisted_query_required',
    });
  });

  it('refuses a batch (an array body) as a raw document', () => {
    expect(decidePersisted([hashed(RUNS_ID)], MANIFESTS, true)).toEqual({
      allow: false,
      code: 'persisted_query_required',
    });
  });

  it('refuses everything, ids included, when the current manifest is empty (fail closed)', () => {
    expect(decidePersisted(hashed(RUNS_ID), EMPTY, true)).toEqual({
      allow: false,
      code: 'persisted_manifest_unavailable',
    });
    expect(decidePersisted({ query: RUNS }, EMPTY, true)).toMatchObject({
      code: 'persisted_manifest_unavailable',
    });
  });

  it('does not serve earlier generations while the current manifest is empty', () => {
    const onlyRetired: PersistedManifests = { current: new Map(), previous: MANIFESTS.previous };
    expect(decidePersisted(hashed(RETIRED_ID), onlyRetired, true)).toMatchObject({
      code: 'persisted_manifest_unavailable',
    });
  });

  it('serves an id from the previous generation within the grace window', () => {
    expect(decidePersisted(hashed(RETIRED_ID), MANIFESTS, true)).toEqual({
      allow: true,
      hash: RETIRED_ID,
      query: RETIRED,
    });
  });
});

describe('decidePersisted (development: raw documents allowed)', () => {
  it('runs a raw query string (DX preserved)', () => {
    expect(decidePersisted({ query: RUNS }, MANIFESTS, false)).toEqual({ allow: true });
  });

  it('runs a request with neither a query nor an id, leaving the error to Mercurius', () => {
    expect(decidePersisted({}, MANIFESTS, false)).toEqual({ allow: true });
  });

  it('still resolves a known id and refuses an unknown one', () => {
    expect(decidePersisted(hashed(RUNS_ID), MANIFESTS, false)).toMatchObject({
      allow: true,
      query: RUNS,
    });
    expect(decidePersisted(hashed(UNKNOWN_ID), MANIFESTS, false)).toMatchObject({
      code: 'persisted_query_not_found',
    });
  });

  it('accepts an id that matches the document it arrives with (APQ-style retry)', () => {
    expect(decidePersisted(hashed(RUNS_ID, { query: RUNS }), MANIFESTS, false)).toEqual({
      allow: true,
      hash: RUNS_ID,
    });
  });

  it('canonicalises before hashing, so layout differences do not fail the id check', () => {
    const spread = 'query Runs {\n  runs {\n    id\n  }\n}';
    expect(decidePersisted(hashed(RUNS_ID, { query: spread }), MANIFESTS, false)).toMatchObject({
      allow: true,
    });
  });

  it('refuses an id that does not match its document', () => {
    expect(decidePersisted(hashed(RUNS_ID, { query: SECOND }), MANIFESTS, false)).toEqual({
      allow: false,
      code: 'persisted_query_hash_mismatch',
      hash: RUNS_ID,
    });
  });

  it('refuses a document that does not parse rather than trusting its id', () => {
    expect(decidePersisted(hashed(RUNS_ID, { query: 'query {' }), MANIFESTS, false)).toMatchObject({
      code: 'persisted_query_hash_mismatch',
    });
  });

  it('treats a non-object body as no envelope, passing it on', () => {
    expect(decidePersisted('query', MANIFESTS, false)).toEqual({ allow: true });
  });
});

describe('loadPersistedManifests', () => {
  let dir: string;
  let logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  const asLogger = (): Logger => logger as unknown as Logger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'persisted-'));
    logger = { error: vi.fn(), warn: vi.fn() };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  it('loads the current and previous generations', () => {
    const current = write('current.json', JSON.stringify({ [RUNS_ID]: RUNS }));
    const previous = write('previous.json', JSON.stringify([{ [RETIRED_ID]: RETIRED }]));
    const loaded = loadPersistedManifests({ current, previous }, asLogger());
    expect(loaded.current.get(RUNS_ID)).toBe(RUNS);
    expect(loaded.previous[0]?.get(RETIRED_ID)).toBe(RETIRED);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails closed to an empty current manifest when the file is missing, and logs an error', () => {
    const loaded = loadPersistedManifests(
      { current: join(dir, 'missing.json'), previous: join(dir, 'missing-prev.json') },
      asLogger(),
    );
    expect(loaded.current.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'graphql.persisted_manifest_unreadable',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'graphql.persisted_manifest_unavailable',
    );
  });

  it('fails closed on malformed JSON and on a wrong shape', () => {
    expect(
      loadPersistedManifests(
        { current: write('bad.json', '{not json'), previous: write('p.json', '[]') },
        asLogger(),
      ).current.size,
    ).toBe(0);
    expect(
      loadPersistedManifests(
        {
          current: write('shape.json', JSON.stringify({ short: RUNS })),
          previous: write('p2.json', '[]'),
        },
        asLogger(),
      ).current.size,
    ).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'graphql.persisted_manifest_invalid',
    );
  });

  it('drops an entry whose text does not hash to its key, so a tampered id cannot serve other text', () => {
    const current = write(
      'tampered.json',
      JSON.stringify({ [RUNS_ID]: SECOND, [SECOND_ID]: SECOND }),
    );
    const loaded = loadPersistedManifests(
      { current, previous: write('p3.json', '[]') },
      asLogger(),
    );
    expect(loaded.current.has(RUNS_ID)).toBe(false);
    expect(loaded.current.get(SECOND_ID)).toBe(SECOND);
    expect(logger.error).toHaveBeenCalledWith(
      { hash: RUNS_ID },
      'graphql.persisted_entry_rejected',
    );
  });

  it('refuses more previous generations than the grace window allows', () => {
    const generation = { [RETIRED_ID]: RETIRED };
    const previous = write('many.json', JSON.stringify([generation, generation, generation]));
    expect(
      loadPersistedManifests({ current: write('c.json', '{}'), previous }, asLogger()).previous,
    ).toHaveLength(0);
  });
});
