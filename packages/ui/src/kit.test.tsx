// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  FormField,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Skeleton,
  cn,
} from './index';

const root = process.cwd();

afterEach(cleanup);

describe('cn', () => {
  it('lets the last conflicting Tailwind class win', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    expect(cn('bg-primary', false, undefined, 'bg-destructive')).toBe('bg-destructive');
  });
});

describe('Button', () => {
  it('renders variant and size classes and defaults to type=button', () => {
    render(
      <Button variant="destructive" size="sm">
        Delete
      </Button>,
    );
    const el = screen.getByRole('button', { name: 'Delete' });
    expect(el.className).toContain('bg-destructive');
    expect(el.className).toContain('h-8');
    expect(el.getAttribute('type')).toBe('button');
  });

  it('merges caller classes over variant classes and forwards refs', () => {
    let node: HTMLButtonElement | null = null;
    render(
      <Button
        className="bg-kill"
        ref={(n) => {
          node = n;
        }}
      >
        Go
      </Button>,
    );
    expect(screen.getByRole('button').className).toContain('bg-kill');
    expect(screen.getByRole('button').className).not.toContain('bg-primary ');
    expect(node).toBe(screen.getByRole('button'));
  });

  it('asChild renders the child element', () => {
    render(
      <Button asChild>
        <a href="/x">Link</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Link' }).className).toContain('bg-primary');
  });
});

describe('Dialog', () => {
  it('opens with role=dialog and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByText('Open'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes via the labelled close button', async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>T</DialogTitle>
          <DialogDescription>D</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('presentational atoms', () => {
  it('Table renders semantic table roles', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Row</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Row' })).toBeTruthy();
  });

  it('Badge and Skeleton render', () => {
    render(
      <>
        <Badge variant="critical">Critical</Badge>
        <Skeleton data-testid="sk" />
      </>,
    );
    expect(screen.getByText('Critical').className).toContain('bg-critical');
    expect(screen.getByTestId('sk').getAttribute('aria-hidden')).toBe('true');
  });

  it('Tabs switch panels', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">panel-a</TabsContent>
        <TabsContent value="b">panel-b</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByText('panel-b')).toBeTruthy();
  });

  it('FormField wires label, description and error to the control', () => {
    render(
      <FormField label="Email" description="Work address" error="Required">
        {(control) => <Input {...control} />}
      </FormField>,
    );
    const input = screen.getByLabelText('Email');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input.getAttribute('aria-describedby') ?? '';
    expect(described.split(' ')).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe('Required');
  });
});

describe('design tokens', () => {
  const css = readFileSync(resolve(root, 'src/styles/tokens.css'), 'utf8');
  const tokens = JSON.parse(readFileSync(resolve(root, '../../design/tokens.json'), 'utf8')) as {
    color: Record<string, { light: string; dark: string }>;
  };

  const block = (selector: string): string => {
    const re = new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'gm');
    return [...css.matchAll(re)].map((m) => m[1] ?? '').join('\n');
  };

  it('mirrors design/tokens.json in :root and .dark', () => {
    const pairs: [string, string][] = [
      ['background', 'bg'],
      ['foreground', 'text'],
      ['primary', 'primary'],
      ['border', 'border'],
      ['kill', 'kill'],
    ];
    for (const [cssName, key] of pairs) {
      const entry = tokens.color[key];
      expect(entry).toBeDefined();
      expect(block(':root')).toContain(`--${cssName}: ${entry?.light ?? ''};`);
      expect(block('.dark')).toContain(`--${cssName}: ${entry?.dark ?? ''};`);
    }
  });

  it('defines --radius once and derives theme radii from it', () => {
    expect(css.match(/--radius:/g)).toHaveLength(1);
    const theme = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8');
    expect(theme).toContain('--radius-lg: var(--radius)');
    expect(theme).toContain('--color-background: var(--background)');
  });
});
