import { describe, expect, it } from 'vitest';

import { HELP_TOPIC_IDS, resolveDocsLink, HELP_TOPICS } from '@blackwing/ui';

import { setClientEventSink, type ClientEvent } from './client-events';
import {
  recordEmptyStateCta,
  recordHelpOpened,
  CONSOLE_DOCS_BASE_URL,
  CONSOLE_DOCS_VERSION,
} from './console-help';

function capture(run: () => void): ClientEvent[] {
  const seen: ClientEvent[] = [];
  const restore = setClientEventSink((event) => seen.push(event));
  try {
    run();
  } finally {
    restore();
  }
  return seen;
}

describe('recordHelpOpened', () => {
  it('counts a popover opening by topic and route, nothing else', () => {
    const events = capture(() => {
      recordHelpOpened('coverage', '/assessments/0b9f1c2e-1111-4222-8333-444455556666?tab=1');
    });
    expect(events).toEqual([
      { event: 'help_popover_opened', route: '/assessments/:id', topic: 'coverage' },
    ]);
  });

  it('drops a topic that is not a safe low-cardinality token', () => {
    const events = capture(() => {
      recordHelpOpened('baseline', '/x');
      recordHelpOpened('a b c' as never, '/x');
    });
    expect(events.map((e) => e.topic)).toEqual(['baseline', undefined]);
  });
});

describe('recordEmptyStateCta', () => {
  it('counts the CTA click by empty-state kind', () => {
    const events = capture(() => {
      recordEmptyStateCta('runs', '/assessments');
    });
    expect(events).toEqual([
      { event: 'empty_state_cta_click', route: '/assessments', topic: 'runs' },
    ]);
  });
});

describe('console docs links', () => {
  it('resolve every topic to the pinned version under the same-origin docs path', () => {
    for (const id of HELP_TOPIC_IDS) {
      const topic = HELP_TOPICS[id];
      const href = resolveDocsLink({
        baseUrl: CONSOLE_DOCS_BASE_URL,
        version: CONSOLE_DOCS_VERSION,
        page: topic.page,
        anchor: topic.anchor,
      });
      expect(href).toBe(`/docs/${CONSOLE_DOCS_VERSION}/${topic.page}#${topic.anchor}`);
    }
  });
});
