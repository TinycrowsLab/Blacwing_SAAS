import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@blackwing/ui';

describe('@blackwing/ui consumed by apps/web', () => {
  it('renders Button, Dialog and Table on the server', () => {
    const html = renderToString(
      createElement(
        'div',
        null,
        createElement(Button, { variant: 'secondary' }, 'Run'),
        createElement(
          Dialog,
          { open: false },
          createElement(
            DialogContent,
            null,
            createElement(DialogTitle, null, 'T'),
            createElement(DialogDescription, null, 'D'),
          ),
        ),
        createElement(
          Table,
          null,
          createElement(
            TableBody,
            null,
            createElement(TableRow, null, createElement(TableCell, null, 'cell')),
          ),
        ),
      ),
    );
    expect(html).toContain('bg-secondary');
    expect(html).toContain('<table');
    expect(html).toContain('cell');
  });
});
