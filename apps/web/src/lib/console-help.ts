import { emitClientEvent } from './client-events';

import type { HelpTopicId } from '@blackwing/ui';

/** Guide origin the console links to. Same-origin so the link works without a third-party host at run time. */
export const CONSOLE_DOCS_BASE_URL = '/docs';

/** Guide version the console links to. Bump with the docs release that rewrites the anchors. */
export const CONSOLE_DOCS_VERSION = 'v1';

/** `help_popover_opened_total{topic}`: counts a help popover opening. Only the topic id is recorded. */
export function recordHelpOpened(topic: HelpTopicId, route: string): void {
  emitClientEvent('help_popover_opened', route, { topic });
}

/** Empty-state CTA click counter, labelled by the empty-state kind (never by the record it sits under). */
export function recordEmptyStateCta(kind: string, route: string): void {
  emitClientEvent('empty_state_cta_click', route, { topic: kind });
}
