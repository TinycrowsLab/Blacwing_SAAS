import { describe, expect, it } from 'vitest';

import { exchange, observation } from './fixtures.js';
import { evaluateMarker, visibleText } from './marker.js';

const TOKEN = 'bw-marker-7f3a';

describe('evaluateMarker', () => {
  it('fires when the declared token is reflected in the body', () => {
    const verdict = evaluateMarker(observation([exchange({ body: `<p>hello ${TOKEN}</p>` })]), {
      token: TOKEN,
      location: 'body',
    });
    expect(verdict).toEqual({ matched: true, reason: 'marker_reflected' });
  });

  it('does not fire when the token is absent from the body', () => {
    const verdict = evaluateMarker(observation([exchange({ body: '<p>nothing</p>' })]), {
      token: TOKEN,
    });
    expect(verdict).toEqual({ matched: false, reason: 'marker_absent' });
  });

  it('does not fire on a partial or encoded form of the token (exact match only)', () => {
    const encoded = encodeURIComponent(TOKEN).replace('-', '%2D');
    expect(
      evaluateMarker(observation([exchange({ body: `${TOKEN.slice(0, 6)} and ${encoded}` })]), {
        token: TOKEN,
      }).matched,
    ).toBe(false);
  });

  it('matches canonically equal Unicode (NFC) on both sides', () => {
    const token = 'caf\u00e9-marker';
    const decomposed = 'cafe\u0301-marker';
    expect(evaluateMarker(observation([exchange({ body: decomposed })]), { token }).matched).toBe(
      true,
    );
  });

  it('checks header values when the location is header', () => {
    const withHeader = exchange({
      body: '',
      headers: [{ name: 'x-echo', value: `reflected:${TOKEN}` }],
    });
    expect(
      evaluateMarker(observation([withHeader]), { token: TOKEN, location: 'header' }).matched,
    ).toBe(true);
    expect(
      evaluateMarker(observation([exchange({ body: TOKEN, headers: [] })]), {
        token: TOKEN,
        location: 'header',
      }).matched,
    ).toBe(false);
  });

  it('ignores a token that appears only inside markup when the location is dom', () => {
    const html = `<div data-x="${TOKEN}"></div><script>var t="${TOKEN}";</script>`;
    expect(
      evaluateMarker(observation([exchange({ body: html })]), { token: TOKEN, location: 'dom' })
        .matched,
    ).toBe(false);
    expect(
      evaluateMarker(observation([exchange({ body: `<b>${TOKEN}</b>` })]), {
        token: TOKEN,
        location: 'dom',
      }).matched,
    ).toBe(true);
  });

  it('returns no_observation for an empty observation, a null status or a missing header set', () => {
    expect(evaluateMarker(observation([]), { token: TOKEN })).toEqual({
      matched: false,
      reason: 'no_observation',
    });
    expect(evaluateMarker(observation([exchange({ status: null })]), { token: TOKEN })).toEqual({
      matched: false,
      reason: 'no_observation',
    });
    expect(evaluateMarker(observation([exchange()]), { token: TOKEN, location: 'header' })).toEqual(
      { matched: false, reason: 'no_observation' },
    );
  });

  it('refuses malformed params without firing and without throwing', () => {
    const reflected = observation([exchange({ body: TOKEN })]);
    for (const params of [null, 'token', {}, { token: '' }, { token: TOKEN, command: 'x' }]) {
      expect(evaluateMarker(reflected, params)).toEqual({
        matched: false,
        reason: 'invalid_params',
      });
    }
  });
});

describe('visibleText', () => {
  it('drops tags, script and style contents, and an unclosed script to the end', () => {
    expect(visibleText('<p>a</p><style>b</style><script>c</script>d')).not.toMatch(/[bc]/);
    expect(visibleText('x<script>secret')).toBe('x ');
    expect(visibleText('<p>visible</p>')).toContain('visible');
  });
});
