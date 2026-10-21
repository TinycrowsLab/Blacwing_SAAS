// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FirstRunChecklist, type FirstRunStep } from './first-run-checklist';

afterEach(() => {
  cleanup();
});

function stepItem(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-step="${id}"]`);
  if (el === null) throw new Error(`missing step ${id}`);
  return el;
}

const steps: FirstRunStep[] = [
  { id: 'verify-asset', label: 'Verify an asset', done: true },
  {
    id: 'create-sa',
    label: 'Create a standing authorisation',
    done: false,
    href: '/authorisations/new',
  },
  {
    id: 'request-run',
    label: 'Request an assessment',
    done: false,
    disabledReason: 'Your role cannot request assessments.',
  },
];

describe('FirstRunChecklist', () => {
  it('reports progress and marks each step done or to do', () => {
    render(<FirstRunChecklist title="Get started" steps={steps} />);
    expect(screen.getByText('1 of 3 done')).toBeTruthy();
    expect(stepItem('verify-asset').getAttribute('data-done')).toBe('true');
    expect(stepItem('create-sa').getAttribute('data-done')).toBe('false');
    expect(screen.getByLabelText('Done')).toBeTruthy();
    expect(screen.getAllByLabelText('To do')).toHaveLength(2);
  });

  it('links only steps that are still to do and can be acted on', () => {
    render(<FirstRunChecklist title="Get started" steps={steps} />);
    const sa = stepItem('create-sa');
    expect(
      within(sa)
        .getByRole('link', { name: 'Create a standing authorisation' })
        .getAttribute('href'),
    ).toBe('/authorisations/new');
    const verified = stepItem('verify-asset');
    expect(within(verified).queryByRole('link')).toBeNull();
  });

  it('shows the reason a step cannot be acted on', () => {
    render(<FirstRunChecklist title="Get started" steps={steps} />);
    expect(screen.getByText('Your role cannot request assessments.')).toBeTruthy();
  });

  it('never renders a link for a done step, even with an href', () => {
    render(
      <FirstRunChecklist
        title="Get started"
        steps={[{ id: 'x', label: 'Done step', done: true, href: '/x' }]}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Done step').className).toContain('line-through');
  });
});
