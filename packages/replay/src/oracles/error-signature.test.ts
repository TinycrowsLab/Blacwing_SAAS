import { describe, expect, it } from 'vitest';

import { evaluateErrorSignatureBinding } from './error-signature.js';
import { exchange, header, observation } from './fixtures.js';

describe('evaluateErrorSignatureBinding', () => {
  it('fires when a declared signature appears in the body and names it', () => {
    const verdict = evaluateErrorSignatureBinding(
      observation([exchange({ status: 500, body: 'SQLITE_ERROR: near "\'": syntax error' })]),
      { signatures: ['SQLITE_ERROR'] },
    );
    expect(verdict).toEqual({
      matched: true,
      signature: 'SQLITE_ERROR',
      reason: 'error_signature_present',
    });
  });

  it('does not fire when no declared signature is present', () => {
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ body: '<p>products</p>' })]), {
        signatures: ['SQLITE_ERROR'],
      }),
    ).toEqual({ matched: false, reason: 'error_signature_absent' });
  });

  it('names the first declared signature that matches, in declared order', () => {
    const verdict = evaluateErrorSignatureBinding(
      observation([exchange({ body: 'PDOException and SQLSTATE[42000]' })]),
      { signatures: ['SQLSTATE[42000]', 'PDOException'] },
    );
    expect(verdict.signature).toBe('SQLSTATE[42000]');
  });

  it('matches case-sensitively, so a differently cased token does not fire', () => {
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ body: 'sqlite_error' })]), {
        signatures: ['SQLITE_ERROR'],
      }).matched,
    ).toBe(false);
  });

  it('matches NFC-equal Unicode on both sides', () => {
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ body: 'errór' })]), {
        signatures: ['errór'],
      }).matched,
    ).toBe(true);
  });

  it('searches response header values only for the header scope', () => {
    const withHeader = exchange({
      headers: [header('x-powered-by', 'PHP/8.1.2')],
      body: 'plain',
    });
    expect(
      evaluateErrorSignatureBinding(observation([withHeader]), {
        signatures: ['PHP/8.1'],
        scope: 'header',
      }).matched,
    ).toBe(true);
    expect(
      evaluateErrorSignatureBinding(observation([withHeader]), { signatures: ['PHP/8.1'] }).matched,
    ).toBe(false);
  });

  it('reports no observation for the header scope when the transport returned no headers', () => {
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ body: 'PHP/8.1' })]), {
        signatures: ['PHP/8.1'],
        scope: 'header',
      }),
    ).toEqual({ matched: false, reason: 'no_observation' });
  });

  it('reports no observation for an empty observation or a probe with no status', () => {
    expect(evaluateErrorSignatureBinding(observation([]), { signatures: ['x'] })).toEqual({
      matched: false,
      reason: 'no_observation',
    });
    expect(
      evaluateErrorSignatureBinding(observation([exchange({ status: null })]), {
        signatures: ['x'],
      }),
    ).toEqual({ matched: false, reason: 'no_observation' });
  });

  it('fails closed for malformed params, an empty list or a duplicate list', () => {
    const body = observation([exchange({ body: 'SQLITE_ERROR' })]);
    expect(evaluateErrorSignatureBinding(body, { signatures: [] })).toEqual({
      matched: false,
      reason: 'invalid_params',
    });
    expect(evaluateErrorSignatureBinding(body, { signatures: ['A', 'A'] }).matched).toBe(false);
    expect(evaluateErrorSignatureBinding(body, { signature: 'SQLITE_ERROR' }).matched).toBe(false);
  });
});
