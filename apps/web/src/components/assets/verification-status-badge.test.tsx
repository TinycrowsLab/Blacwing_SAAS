// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { VerificationStatusBadge } from './verification-status-badge';

afterEach(cleanup);

describe('VerificationStatusBadge', () => {
  it.each([
    ['unverified', 'Unverified', 'text-foreground'],
    ['pending', 'Pending', 'text-warning'],
    ['verified', 'Verified', 'text-success'],
    ['rejected', 'Rejected', 'text-danger'],
  ] as const)('renders %s with its text label and a tone class', (status, label, tone) => {
    render(<VerificationStatusBadge status={status} />);
    const badge = screen.getByText(label);
    expect(badge.closest('[data-status]')?.getAttribute('data-status')).toBe(status);
    expect(badge.closest('[data-status]')?.className).toContain(tone);
  });

  it('keeps the icon out of the accessible name, so the label carries the state', () => {
    const { container } = render(<VerificationStatusBadge status="verified" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Verified')).toBeTruthy();
  });
});
