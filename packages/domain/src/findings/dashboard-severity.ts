// Severity buckets of the dashboard (DASH-001). The dashboard reports the CVSS v4.0 band with the names the console
// shows: `info` is the band FIRST calls `none` (a score of 0). The thresholds are `bandOf` (cvss.ts), so the dashboard
// and the stored `severity.cvss4.severity` can never disagree.

import { ValidationError } from '@blackwing/errors';

import { bandOf } from './cvss.js';

import type { CvssSeverityBand, DashboardSeverity } from '@blackwing/contracts';

/** The top of the CVSS v4.0 base score range. */
const CVSS_SCORE_MAX = 10;

/** The dashboard bucket of a CVSS v4.0 qualitative band. */
export function dashboardSeverityOfBand(band: CvssSeverityBand): DashboardSeverity {
  return band === 'none' ? 'info' : band;
}

/** The dashboard bucket of a CVSS v4.0 base score in [0, 10]. A score outside the range is refused, never bucketed. */
export function dashboardSeverityOfScore(score: number): DashboardSeverity {
  if (!Number.isFinite(score) || score < 0 || score > CVSS_SCORE_MAX) {
    throw new ValidationError('CVSS score is out of range', {
      detail: 'A CVSS v4.0 base score is a number from 0 to 10.',
    });
  }
  return dashboardSeverityOfBand(bandOf(score));
}

/** The stored CVSS band(s) a dashboard severity filter matches: `info` is stored as `none`. */
export function storedBandOfSeverity(severity: DashboardSeverity): CvssSeverityBand {
  return severity === 'info' ? 'none' : severity;
}
