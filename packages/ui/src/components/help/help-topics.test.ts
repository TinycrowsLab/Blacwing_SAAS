import { describe, expect, it } from 'vitest';

import { HELP_TOPIC_IDS, HELP_TOPICS, isHelpTopicId } from './help-topics';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Copy must never carry customer data or credentials: no e-mail, URL, bearer or token-shaped strings, IDs.
const FORBIDDEN = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /https?:\/\//i,
  /\bbw_(?:pat|ci)_/,
  /\b(?:password|secret|api[_-]?key|bearer)\b/i,
  /\b(?:SA|run|fnd|asset)[-_][0-9A-Za-z]{4,}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-/i,
];

describe('HELP_TOPICS', () => {
  it('covers every concept the issue lists', () => {
    expect([...HELP_TOPIC_IDS].sort()).toEqual(
      [
        'approval-gates',
        'baseline',
        'budgets',
        'confirmed-vs-suspected',
        'coverage',
        'intrusiveness',
        'separation-of-duties',
      ].sort(),
    );
  });

  it('has an entry for every id and no extra keys', () => {
    expect(Object.keys(HELP_TOPICS).sort()).toEqual([...HELP_TOPIC_IDS].sort());
  });

  it.each(HELP_TOPIC_IDS)('%s has a short summary, a slug page and a slug anchor', (id) => {
    const topic = HELP_TOPICS[id];
    expect(topic.title.length).toBeGreaterThan(0);
    expect(topic.summary.length).toBeGreaterThan(40);
    expect(topic.summary.length).toBeLessThanOrEqual(260);
    expect(topic.page).toMatch(SLUG);
    expect(topic.anchor).toMatch(SLUG);
  });

  it.each(HELP_TOPIC_IDS)('%s copy carries no secrets, URLs, IDs or customer data', (id) => {
    const text = `${HELP_TOPICS[id].title} ${HELP_TOPICS[id].summary}`;
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
  });

  it('is frozen so a caller cannot change the copy at run time', () => {
    expect(Object.isFrozen(HELP_TOPICS)).toBe(true);
  });
});

describe('isHelpTopicId', () => {
  it('accepts known ids only', () => {
    expect(isHelpTopicId('coverage')).toBe(true);
    expect(isHelpTopicId('Coverage')).toBe(false);
    expect(isHelpTopicId('__proto__')).toBe(false);
    expect(isHelpTopicId('constructor')).toBe(false);
    expect(isHelpTopicId(undefined)).toBe(false);
    expect(isHelpTopicId(42)).toBe(false);
  });
});
