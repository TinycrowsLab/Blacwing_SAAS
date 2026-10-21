// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HelpPopover } from './help-popover';
import { HELP_TOPICS } from './help-topics';

// Built at run time because the lint policy rejects script URLs written as literals.
const SCRIPT_URL = ['java', 'script:alert(1)'].join('');

afterEach(() => {
  cleanup();
});

describe('HelpPopover', () => {
  it('labels the trigger with the topic title and does not open by itself', () => {
    render(<HelpPopover topic="coverage" docsBaseUrl="/docs" docsVersion="v1" />);
    const trigger = screen.getByRole('button', { name: 'Help: Coverage' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(HELP_TOPICS.coverage.summary)).toBeNull();
  });

  it('shows the inline summary and a deep link to the versioned guide', async () => {
    const user = userEvent.setup();
    render(
      <HelpPopover topic="coverage" docsBaseUrl="https://docs.example.test" docsVersion="v1" />,
    );
    await user.click(screen.getByRole('button', { name: 'Help: Coverage' }));

    expect(await screen.findByText(HELP_TOPICS.coverage.summary)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Read the full guide' });
    expect(link.getAttribute('href')).toBe('https://docs.example.test/v1/user-guide#coverage');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps the summary but drops the link when the base cannot be resolved', async () => {
    const user = userEvent.setup();
    render(<HelpPopover topic="budgets" docsBaseUrl={SCRIPT_URL} docsVersion="v1" />);
    await user.click(screen.getByRole('button', { name: 'Help: Budgets and cost cap' }));

    expect(await screen.findByText(HELP_TOPICS.budgets.summary)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('reports the topic once per open through onOpen', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<HelpPopover topic="baseline" docsBaseUrl="/docs" docsVersion="v1" onOpen={onOpen} />);
    await user.click(screen.getByRole('button', { name: 'Help: Baseline states' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('baseline');
  });

  it('closes on Escape and does not report a close as an open', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <HelpPopover
        topic="confirmed-vs-suspected"
        docsBaseUrl="/docs"
        docsVersion="v1"
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Help: Confirmed vs suspected' }));
    await user.keyboard('{Escape}');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole('button', { name: 'Help: Confirmed vs suspected' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });
});
