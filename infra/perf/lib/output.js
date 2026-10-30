// Result output for the harness (PERF-001, #320): JSON summary files under infra/perf/results/ and a one-line
// stdout pointer. Prometheus output is wired by the Makefile (K6_PROMETHEUS_RW_SERVER_URL), not here.

import { redact } from './auth.js';

export const RESULTS_DIR = 'infra/perf/results';

/** Largest number of code points kept from a response body when it is quoted in a log line. */
export const BODY_SAMPLE_LIMIT = 256;

/**
 * Caps text to a code-point budget (surrogate-pair safe), so large or unicode bodies cannot blow up logs.
 *
 * @param {string | undefined | null} body
 * @param {number} [limit]
 * @returns {string}
 */
export function capBody(body, limit = BODY_SAMPLE_LIMIT) {
  if (body === undefined || body === null) return '';
  const text = body;
  // Look at no more than 2 * limit UTF-16 units: a code point is at most 2 units, so this is enough to fill the budget.
  const head = Array.from(text.slice(0, limit * 2));
  const whole = text.length <= limit * 2 && head.length <= limit;
  return whole ? text : `${head.slice(0, limit).join('')}…`;
}

/**
 * ISO-8601 UTC timestamp that is safe in a filename (colons become dashes), e.g. 2026-10-30T13-00-00.000Z.
 *
 * @param {Date} now
 * @returns {string}
 */
export function fileTimestamp(now) {
  return now.toISOString().replace(/:/g, '-');
}

/**
 * Builds the k6 handleSummary() return value: the JSON summary file and a stdout pointer. The token is
 * redacted from the serialised summary as a last line of defence.
 *
 * @param {unknown} data k6 summary data
 * @param {{ scriptName: string, token: string, now: Date, dir?: string }} opts
 * @returns {Record<string, string>} map of output path (relative to the k6 working directory) to contents
 */
export function summaryOutputs(data, opts) {
  const dir = opts.dir ?? RESULTS_DIR;
  const file = `${dir}/${opts.scriptName}-${fileTimestamp(opts.now)}.json`;
  return {
    [file]: redact(JSON.stringify(data, null, 2), opts.token),
    stdout: `results written to ${file}\n`,
  };
}
