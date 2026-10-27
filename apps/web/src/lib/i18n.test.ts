import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE,
  formatDate,
  formatMessage,
  formatNumber,
  t,
  type MessageKey,
} from './i18n';

describe('t', () => {
  it('resolves catalogue keys to their English text', () => {
    expect(t('nav.item.audit')).toBe('Audit log');
    expect(t('common.openNavigation')).toBe('Open navigation');
  });

  it('is a compile error to ask for a key that is not in the catalogue', () => {
    // @ts-expect-error nav.item.nope is not a catalogue key; typecheck fails if this stops erroring.
    const missing: MessageKey = 'nav.item.nope';
    expect(missing).toBe('nav.item.nope');
  });

  it('renders the key name for a missing key at runtime', () => {
    expect(t('unit.only.missing' as MessageKey)).toBe('unit.only.missing');
  });

  it('never resolves inherited object properties as messages', () => {
    expect(t('constructor' as MessageKey)).toBe('constructor');
    expect(t('__proto__' as MessageKey)).toBe('__proto__');
  });
});

describe('formatMessage', () => {
  it('interpolates named params, including zero', () => {
    expect(formatMessage('{count} runs in {team}', { count: 0, team: 'Red' })).toBe(
      '0 runs in Red',
    );
  });

  it('leaves a placeholder without a matching param visible', () => {
    expect(formatMessage('Hello {name}', {})).toBe('Hello {name}');
    expect(formatMessage('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
  });

  it('does not treat inherited names as params', () => {
    expect(formatMessage('{constructor}', {})).toBe('{constructor}');
  });

  it('inserts values literally, never as markup or patterns', () => {
    expect(formatMessage('Hi {name}', { name: '$& <b>x</b>' })).toBe('Hi $& <b>x</b>');
  });
});

describe('Intl formatting', () => {
  it('formats dates in the default locale with the given time zone', () => {
    const date = new Date(Date.UTC(2026, 0, 5, 12));
    expect(DEFAULT_LOCALE).toBe('en');
    expect(formatDate(date, { dateStyle: 'medium', timeZone: 'UTC' })).toBe('Jan 5, 2026');
    expect(formatDate(date.getTime(), { dateStyle: 'short', timeZone: 'UTC' })).toBe('1/5/26');
  });

  it('formats numbers with locale grouping', () => {
    expect(formatNumber(1234567.5)).toBe('1,234,567.5');
    expect(formatNumber(0.25, { style: 'percent' })).toBe('25%');
  });
});
