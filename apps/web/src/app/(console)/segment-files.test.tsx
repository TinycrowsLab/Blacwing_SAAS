// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import ConsoleError from './error';
import ConsoleLoading from './loading';
import ConsoleNotFound from './not-found';

afterEach(cleanup);

describe('(console) segment files', () => {
  it('error.tsx never renders error.message and offers reset', () => {
    const error = Object.assign(new Error('db password=hunter2 at x (/a.js:1:1)'), {
      digest: 'dig-123',
    });
    const { container } = render(<ConsoleError error={error} reset={() => undefined} />);
    expect(container.textContent).not.toContain('hunter2');
    expect(container.textContent).toContain('dig-123');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('not-found.tsx renders NotFound and loading.tsx renders a status', () => {
    render(<ConsoleNotFound />);
    expect(screen.getByText('We could not find that page')).toBeTruthy();
    cleanup();
    render(<ConsoleLoading />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  });
});
