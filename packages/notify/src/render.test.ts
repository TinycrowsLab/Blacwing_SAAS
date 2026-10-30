import { describe, expect, it } from 'vitest';

import { consoleLinkFor, RENDER_TEXT_MAX, renderNotification } from './render.js';

import type { NotificationRequest } from '@blackwing/contracts';

const RUN_ID = '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a78';
const CONSOLE = 'https://console.blackwing.example';

const request = (overrides: Partial<NotificationRequest> = {}): NotificationRequest => ({
  tenantId: '018f5c2e-7b1a-7d3e-9a4f-2c1d0e9b8a77',
  event: 'run.failed',
  severity: 'high',
  subject: 'Run failed',
  body: {},
  ...overrides,
});

const options = { consoleUrl: CONSOLE, supportsActions: true };

describe('renderNotification', () => {
  it('renders the event headline and one line per body field', () => {
    const message = renderNotification(
      request({ body: { target: 'app.example.com', attempts: 3, retried: false, reason: null } }),
      options,
    );
    expect(message.subject).toBe('Run failed');
    expect(message.text).toBe(
      [
        'An assessment run failed.',
        'target: app.example.com',
        'attempts: 3',
        'retried: false',
        'reason: -',
      ].join('\n'),
    );
  });

  it('keeps action links structured when the channel renders buttons', () => {
    const actions = [{ label: 'Open run', href: '/runs/1' }];
    const message = renderNotification(request({ actions }), options);
    expect(message.actions).toEqual(actions);
    expect(message.text).not.toContain('Open run');
  });

  it('sends action links as text lines when the channel cannot render buttons', () => {
    const actions = [{ label: 'Open run', href: '/runs/1' }];
    const message = renderNotification(request({ actions }), {
      consoleUrl: CONSOLE,
      supportsActions: false,
    });
    expect(message.actions).toEqual([]);
    expect(message.text.endsWith('Open run: /runs/1')).toBe(true);
  });

  it('truncates a long body with a console link and keeps every action', () => {
    const body = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field${i}`, 'x'.repeat(500)]),
    );
    const actions = [
      { label: 'Approve', href: 'https://console.blackwing.example/approve/1' },
      { label: 'Reject', href: '/reject/1' },
    ];
    const message = renderNotification(request({ runId: RUN_ID, body, actions }), options);
    expect(message.text.length).toBeLessThanOrEqual(RENDER_TEXT_MAX);
    expect(message.text).toContain(
      `Open the console for the full details: ${CONSOLE}/runs/${RUN_ID}`,
    );
    expect(message.actions).toEqual(actions);
  });

  it('keeps the action lines after the cut when the channel shows them as text', () => {
    const body = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field${i}`, 'x'.repeat(500)]),
    );
    const message = renderNotification(
      request({ body, actions: [{ label: 'Reject', href: '/reject/1' }] }),
      { consoleUrl: CONSOLE, supportsActions: false },
    );
    expect(message.text).toContain('... truncated.');
    expect(message.text.endsWith('Reject: /reject/1')).toBe(true);
  });

  it('is pure: the same request always renders the same message', () => {
    const input = request({ body: { a: 'b' } });
    expect(renderNotification(input, options)).toEqual(renderNotification(input, options));
  });
});

describe('consoleLinkFor', () => {
  it('links to the run when the notice names one', () => {
    expect(consoleLinkFor({ runId: RUN_ID }, `${CONSOLE}/`)).toBe(`${CONSOLE}/runs/${RUN_ID}`);
  });

  it('links to the console root otherwise', () => {
    expect(consoleLinkFor({}, `${CONSOLE}//`)).toBe(`${CONSOLE}/`);
  });
});
