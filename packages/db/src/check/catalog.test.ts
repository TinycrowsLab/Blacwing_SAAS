import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { diffCatalog, expectedCatalog, latestSnapshot, normaliseType } from './catalog.js';
import { appendDriftReport, formatDriftReport } from './report.js';

describe('normaliseType', () => {
  it.each([
    ['uuid', 'uuid'],
    ['varchar(255)', 'character varying(255)'],
    ['timestamp', 'timestamp without time zone'],
    ['timestamp(3) with time zone', 'timestamp(3) with time zone'],
    ['serial', 'integer'],
    ['numeric(10, 2)', 'numeric(10,2)'],
    ['"citext"', 'citext'],
    ['text[]', 'text[]'],
    ['vector(1536)', 'vector(1536)'],
  ])('%s -> %s', (input, output) => {
    expect(normaliseType(input)).toBe(output);
  });
});

describe('expectedCatalog', () => {
  it('derives tables, columns, indexes, constraints, policies and RLS from the snapshot', () => {
    const last = migrationNames().at(-1) ?? '';
    const lines = expectedCatalog(latestSnapshot(MIGRATIONS_DIR, last));
    expect(lines).toContain('table public.soc_contacts');
    expect(lines).toContain('column public.soc_contacts.email citext not null');
    expect(lines).toContain('column public.soc_contacts.phone text');
    expect(lines).toContain('index public.soc_contacts.soc_contacts_tenant_asset_idx');
    expect(lines).toContain(
      'constraint public.soc_kill_tokens.soc_kill_tokens_contact_fk foreign key',
    );
    expect(lines).toContain('policy public.kill_events.kill_events_tenant_isolation');
    expect(lines).toContain('rls public.kill_events enabled');
    expect(lines).toEqual(lines.toSorted());
  });

  it('includes column-level unique constraints and enums', () => {
    const lines = expectedCatalog({
      tables: {
        'public.t': {
          name: 't',
          schema: '',
          columns: {
            c: { name: 'c', type: 'text', notNull: false, isUnique: true, uniqueName: 't_c_key' },
          },
          indexes: {},
          foreignKeys: {},
          compositePrimaryKeys: {},
          uniqueConstraints: {},
          checkConstraints: {},
          policies: {},
          isRLSEnabled: false,
        },
      },
      enums: { 'public.s': { name: 's', schema: 'public', values: ['a', 'b'] } },
    });
    expect(lines).toEqual([
      'column public.t.c text',
      'constraint public.t.t_c_key unique',
      'enum public.s (a, b)',
      'rls public.t disabled',
      'table public.t',
    ]);
  });
});

describe('diffCatalog', () => {
  it('is empty when both sides agree', () => {
    expect(diffCatalog(['a', 'b'], ['b', 'a'])).toEqual([]);
  });

  it('marks snapshot-only lines with - and database-only lines with +', () => {
    expect(diffCatalog(['table x', 'column x.a uuid'], ['table x', 'column x.b uuid'])).toEqual([
      '- column x.a uuid',
      '+ column x.b uuid',
    ]);
  });
});

describe('drift report', () => {
  it('renders SQL, diff and bullet sections', () => {
    expect(
      formatDriftReport([
        { title: 'SQL', lines: ['CREATE TABLE t ();'], lang: 'sql' },
        { title: 'Journal', lines: ['bad'] },
      ]),
    ).toBe('## SQL\n\n```sql\nCREATE TABLE t ();\n```\n\n## Journal\n\n- bad\n');
  });

  it('appends to the artifact file and is a no-op without a file or sections', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-report-'));
    try {
      const file = path.join(dir, 'nested', 'db-drift.md');
      appendDriftReport(undefined, [{ title: 'x', lines: ['y'] }]);
      appendDriftReport(file, []);
      appendDriftReport(file, [{ title: 'Diff', lines: ['+ table t'], lang: 'diff' }]);
      expect(readFileSync(file, 'utf8')).toBe('## Diff\n\n```diff\n+ table t\n```\n\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
