import type { RenderedMessage } from './channel.js';
import type { NotificationEventType, NotificationRequest } from '@blackwing/contracts';

/**
 * Renders a request for one channel (NOTIFY-002; the per-channel templates of NOTIFY-003 build on this). The
 * text is one headline, then one line per body field. Only the body is ever cut: when it would exceed
 * {@link RENDER_TEXT_MAX}, it ends with a link to the console, and the action links are appended after the cut,
 * so a critical action is never truncated away.
 */

/** Longest rendered body text, in characters, before the console link replaces the rest. */
export const RENDER_TEXT_MAX = 4000;

const HEADLINES: Readonly<Record<NotificationEventType, string>> = {
  'gate1.requested': 'A Gate 1 scope approval is waiting for a decision.',
  'gate2.exception': 'A runtime exception needs a Gate 2 decision. No reply is treated as denied.',
  'gate3.release_requested': 'A finding release is waiting for Gate 3 triage.',
  'run.completed': 'An assessment run completed.',
  'run.failed': 'An assessment run failed.',
  'kill.fired': 'The kill switch was fired. Target testing is being halted.',
  'soc.test_window': 'An authorised test window is about to start.',
  'soc.window_opened': 'An authorised test window has opened.',
  'budget.cap': 'A cost or request budget cap was reached.',
  'finding.released': 'A finding was released.',
  'system.alert': 'A platform alert was raised.',
};

export interface RenderOptions {
  /** The console origin, used for the truncation link (`/runs/{id}` when the notice names a run). */
  readonly consoleUrl: string;
  /** False when the target channel shows action links as text (its `supportsActions` is false). */
  readonly supportsActions: boolean;
}

/** The console page a notice points to: the run when it names one, otherwise the console root. */
export function consoleLinkFor(
  request: Pick<NotificationRequest, 'runId'>,
  consoleUrl: string,
): string {
  const base = consoleUrl.replace(/\/+$/, '');
  return request.runId === undefined ? `${base}/` : `${base}/runs/${request.runId}`;
}

/** Renders `request` for one channel. Pure: the same input always gives the same message. */
export function renderNotification(
  request: NotificationRequest,
  options: RenderOptions,
): RenderedMessage {
  const actions = request.actions ?? [];
  const lines = [
    HEADLINES[request.event],
    ...Object.entries(request.body).map(
      ([key, value]) => `${key}: ${value === null ? '-' : String(value)}`,
    ),
  ];
  let text = lines.join('\n');
  if (text.length > RENDER_TEXT_MAX) {
    const notice = `\n... truncated. Open the console for the full details: ${consoleLinkFor(request, options.consoleUrl)}`;
    text = `${text.slice(0, RENDER_TEXT_MAX - notice.length)}${notice}`;
  }
  if (!options.supportsActions && actions.length > 0) {
    text = [text, ...actions.map((action) => `${action.label}: ${action.href}`)].join('\n');
  }
  return {
    subject: request.subject,
    text,
    actions: options.supportsActions ? actions : [],
  };
}
