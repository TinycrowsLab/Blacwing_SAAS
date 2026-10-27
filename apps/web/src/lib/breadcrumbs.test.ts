import { describe, expect, it } from 'vitest';

import { breadcrumbsFor } from './breadcrumbs';

describe('breadcrumbsFor', () => {
  it('has no trail at the root', () => {
    expect(breadcrumbsFor('/')).toEqual([]);
  });

  it('maps nested segments and marks only the last as current', () => {
    expect(breadcrumbsFor('/admin/members')).toEqual([
      { label: 'Admin', href: '/admin', current: false },
      { label: 'Members', href: '/admin/members', current: true },
    ]);
  });

  it('never shows raw ids', () => {
    const labels = breadcrumbsFor('/runs/run_01HZXABCDEF/findings/fnd_9ZZZZZZZ').map(
      (c) => c.label,
    );
    expect(labels).toEqual(['Runs', 'Run', 'Findings', 'Finding']);
    expect(breadcrumbsFor('/assets/018f3c1e-1111-7222-8333-444455556666')[1]?.label).toBe(
      'Details',
    );
    expect(breadcrumbsFor('/assets/42')[1]?.label).toBe('Details');
  });

  it('never resolves inherited object properties as segment labels', () => {
    expect(breadcrumbsFor('/constructor')[0]?.label).toBe('Constructor');
    expect(breadcrumbsFor('/__proto__')[0]?.label).toBe('Proto');
  });

  it('uses a loader-resolved label for an href when given', () => {
    expect(
      breadcrumbsFor('/runs/run_01HZXABCDEF', { '/runs/run_01HZXABCDEF': 'Nightly scan' })[1]
        ?.label,
    ).toBe('Nightly scan');
  });

  it('humanises unmapped segments and survives malformed encoding', () => {
    expect(breadcrumbsFor('/runs/some-new_page')[1]?.label).toBe('Some new page');
    expect(breadcrumbsFor('/%E0%A4%A')[0]?.label).toBe('%E0%A4%A');
  });

  it('ignores query and hash and caps depth', () => {
    expect(breadcrumbsFor('/runs?x=1#h')).toHaveLength(1);
    expect(breadcrumbsFor('/a/b/c/d/e/f/g/h/i/j')).toHaveLength(8);
  });
});
