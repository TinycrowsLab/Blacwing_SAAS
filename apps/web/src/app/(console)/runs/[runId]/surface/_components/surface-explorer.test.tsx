// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SURFACE_NODE_KINDS, type SurfaceRunView } from '@blackwing/contracts';

const RUN = '018f2a6e-1c00-7000-8000-000000000001';
const HOST = 'host:018f2a6e-1c00-7000-8000-000000000001:api.example.test';
const SERVICE = 'service:018f2a6e-1c00-7000-8000-000000000001:api.example.test:22/tcp';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => `/runs/${RUN}/surface`,
  useSearchParams: () => new URLSearchParams(search),
}));

// The graph library draws on a canvas. The stub lists the nodes it was handed, so the test can see what reached it.
vi.mock('next/dynamic', () => ({
  default: () =>
    function FakeGraph(props: { graphData: { nodes: { id: string }[] } }) {
      return (
        <ul data-testid="fake-graph">
          {props.graphData.nodes.map((node) => (
            <li key={node.id}>{node.id}</li>
          ))}
        </ul>
      );
    },
}));

const { SurfaceExplorer } = await import('./surface-explorer');

function node(id: string, kind: 'host' | 'service', label: string, degree: number) {
  return {
    id,
    kind,
    label,
    confidence: 0.9,
    degree,
    ...(kind === 'host' ? { inScope: true } : {}),
    provenance: {
      runId: RUN,
      tool: 'nmap',
      firstSeenAt: '2026-10-29T10:00:00.000Z',
      lastSeenAt: '2026-10-29T10:05:00.000Z',
    },
  };
}

function view(overrides: Partial<SurfaceRunView> = {}): SurfaceRunView {
  return {
    nodes: [
      node(HOST, 'host', 'api.example.test', 1),
      node(SERVICE, 'service', 'api.example.test:22/tcp', 1),
    ],
    edges: [{ kind: 'EXPOSES', from: HOST, to: SERVICE }],
    totals: { nodes: 2, edges: 1 },
    truncated: false,
    pageInfo: { hasNextPage: false },
    clusteredBy: 'asset',
    runState: 'recon',
    ...overrides,
  };
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function toUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input, 'http://localhost');
  return input instanceof URL ? input : new URL(input.url);
}

function stubSurface(answer: (url: URL) => Response) {
  const mock = vi.fn((input: string | URL | Request) => Promise.resolve(answer(toUrl(input))));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderExplorer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SurfaceExplorer runId={RUN} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  search = '';
  replace.mockClear();
  // jsdom has no layout: give the canvas a width so the graph mounts.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('surface explorer: the served graph', () => {
  it('asks the BFF for one page of the surface with the filters, and never sends a tenant', async () => {
    search = 'kinds=host&minConfidence=0.4&inScopeOnly=true';
    const mock = stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');

    const url = toUrl(mock.mock.calls[0]?.[0] ?? '');
    expect(url.pathname).toBe(`/v1/runs/${RUN}/surface`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kinds: 'host',
      minConfidence: '0.4',
      inScopeOnly: 'true',
      limit: '200',
    });
    expect([...url.searchParams.keys()].some((key) => /tenant/i.test(key))).toBe(false);
  });

  it('hands the canvas every node of the view and labels the graph for assistive technology', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    const graph = await screen.findByTestId('fake-graph');
    expect(within(graph).getByText(HOST)).toBeTruthy();
    expect(within(graph).getByText(SERVICE)).toBeTruthy();
    expect(screen.getByRole('img', { name: /2 nodes and 1 relationships/ })).toBeTruthy();
  });

  it('loads the following pages until the view is complete, with the cursor of the last node', async () => {
    const mock = stubSurface((url) =>
      url.searchParams.get('cursor') === 'c1'
        ? respond(
            view({
              nodes: [node(SERVICE, 'service', 'api.example.test:22/tcp', 1)],
              edges: [],
              pageInfo: { hasNextPage: false },
            }),
          )
        : respond(
            view({
              nodes: [node(HOST, 'host', 'api.example.test', 1)],
              edges: [],
              totals: { nodes: 2, edges: 1 },
              truncated: true,
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
            }),
          ),
    );
    renderExplorer();
    await waitFor(() => {
      expect(mock.mock.calls.length).toBe(2);
    });
    const second = toUrl(mock.mock.calls[1]?.[0] ?? '');
    expect(second.searchParams.get('cursor')).toBe('c1');
    const graph = await screen.findByTestId('fake-graph');
    await waitFor(() => {
      expect(within(graph).getAllByRole('listitem')).toHaveLength(2);
    });
  });
});

describe('surface explorer: truncation', () => {
  it('shows a non-blocking banner with the shown and total counts when the surface is capped', async () => {
    stubSurface(() =>
      respond(
        view({
          truncated: true,
          totals: { nodes: 5312, edges: 9000 },
          pageInfo: { hasNextPage: false },
        }),
      ),
    );
    renderExplorer();
    const banner = await screen.findByTestId('surface-truncation');
    expect(banner.textContent).toContain('Showing the 2 most relevant nodes of 5312');
    expect(
      within(banner).getByRole('link', { name: 'Narrow the filters' }).getAttribute('href'),
    ).toBe('#surface-filters');
  });

  it('shows no banner for a surface within the caps', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');
    expect(screen.queryByTestId('surface-truncation')).toBeNull();
  });
});

describe('surface explorer: node inspector', () => {
  it('prompts for a selection, then shows the provenance summary of the chosen node only', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');
    expect(
      screen.getByText('Select a node to see what it is and where it came from.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'api.example.test:22/tcp' }));

    const inspector = await screen.findByTestId('surface-inspector-node');
    expect(inspector.textContent).toContain('Service');
    expect(inspector.textContent).toContain('api.example.test:22/tcp');
    expect(inspector.textContent).toContain('nmap');
    expect(inspector.textContent).toContain('Not verified');
    expect(inspector.textContent).toContain(RUN);
  });

  it('keeps the inspector keyboard reachable', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');
    const region = screen.getByRole('region', { name: 'Node inspector' });
    expect(region.getAttribute('tabindex')).toBe('0');
  });
});

describe('surface explorer: filters', () => {
  it('turning a kind off writes the URL, which is the refetch', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');
    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    const expected = SURFACE_NODE_KINDS.filter((kind) => kind !== 'service').join(',');
    expect(replace).toHaveBeenCalledWith(
      `/runs/${RUN}/surface?kinds=${encodeURIComponent(expected)}`,
      {
        scroll: false,
      },
    );
  });

  it('the in-scope switch reports its state and writes it to the URL', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');
    const toggle = screen.getByRole('switch', { name: 'In scope only' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(replace).toHaveBeenCalledWith(`/runs/${RUN}/surface?inScopeOnly=true`, {
      scroll: false,
    });
  });

  it('shows the kind toggles pressed when no kind filter is set', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');
    expect(screen.getByRole('button', { name: 'Host' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('surface explorer: accessibility', () => {
  it('has no axe violations on the loaded page, with an open inspector', async () => {
    stubSurface(() => respond(view({ truncated: true, totals: { nodes: 5312, edges: 9000 } })));
    const { container } = renderExplorer();
    await screen.findByTestId('fake-graph');
    fireEvent.click(screen.getByRole('button', { name: 'api.example.test:22/tcp' }));
    await screen.findByTestId('surface-inspector-node');
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });

  it('builds every filter from native, enabled controls, so the keyboard reaches each one', async () => {
    stubSurface(() => respond(view()));
    renderExplorer();
    await screen.findByTestId('fake-graph');
    const controls = [
      ...(document.getElementById('surface-filters')?.querySelectorAll('button, input') ?? []),
    ];
    // One button per kind, the confidence slider and the scope switch.
    expect(controls).toHaveLength(SURFACE_NODE_KINDS.length + 2);
    for (const control of controls) {
      expect(['BUTTON', 'INPUT']).toContain(control.tagName);
      expect(control.hasAttribute('disabled')).toBe(false);
      expect(control.getAttribute('tabindex')).not.toBe('-1');
    }
  });
});

describe('surface explorer: standard states', () => {
  it('renders an empty state, not a canvas error, for a surface with no nodes', async () => {
    stubSurface(() => respond(view({ nodes: [], edges: [], totals: { nodes: 0, edges: 0 } })));
    renderExplorer();
    expect(await screen.findByText('No surface discovered yet')).toBeTruthy();
    expect(screen.queryByTestId('fake-graph')).toBeNull();
  });

  it('renders the permission-denied state for a 403, not a generic failure', async () => {
    stubSurface(() =>
      respond({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'FORBIDDEN' }, 403),
    );
    renderExplorer();
    await waitFor(() => {
      expect(document.querySelector('[data-state="permission-denied"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-state="error"]')).toBeNull();
  });

  it('renders a typed error card for a server failure, with a retry', async () => {
    stubSurface(() =>
      respond({ type: 'about:blank', title: 'Boom', status: 500, code: 'INTERNAL' }, 500),
    );
    renderExplorer();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
