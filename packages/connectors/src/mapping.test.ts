import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorUnknownProviderError, ConnectorValidationError } from './errors.js';
import {
  buildTicketPayload,
  renderTicketBody,
  type ConnectorMappingMetrics,
  type TicketFindingInput,
  type TicketMappingConfigInput,
  ticketFindingSchema,
} from './mapping.js';
import { TICKET_LIMITS } from './types.js';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@blackwing/logger', () => ({
  createLogger: () => ({ info: logs.info, warn: logs.warn }),
}));

const PUBLIC_ID = 'fnd_01J8ZQ6W0Y5Q7KXP4V3BMZ2T9R';
const CONSOLE_URL = `https://app.blackwing.example/findings/${PUBLIC_ID}`;

/** A released, scored, fully mapped finding. Standards, location, repro and the console link are all present. */
function fixture(overrides: Partial<TicketFindingInput> = {}): TicketFindingInput {
  return {
    publicId: PUBLIC_ID,
    title: 'SQL injection in product search',
    class: 'sqli',
    cweId: 'CWE-89',
    owaspCategory: 'A03',
    asvsRefs: ['v5.0.0-1.2.5'],
    severity: {
      cvss4Vector: CVSS4_VECTOR,
      score: 9.3,
      band: 'critical',
      cvss31Vector: null,
    },
    severityRationale: 'Unauthenticated network injection with full read access.',
    location: {
      method: 'GET',
      urlTemplate: '/api/products/{id}/search',
      parameter: 'q',
      file: null,
      line: null,
    },
    baselineStatus: 'new',
    confidence: 0.92,
    description: 'User-controlled input reaches a SQL query in the product search endpoint.',
    impact: 'A caller can read tenant data outside their own scope.',
    evidenceNarrative: 'Reproduced twice against a control request.',
    narrativePending: false,
    evidenceRefs: [
      {
        evidenceId: '0190f2a4-7b1c-7c3d-9e4f-0a1b2c3d4e5f',
        objectKey: 'evidence/0190f2a4/raw-response.bin',
        sha256: 'a'.repeat(64),
        chain: 'b'.repeat(64),
      },
    ],
    reproArtifactRef: 'rpa_01J8ZQ6W0Y5Q7KXP4V3BMZ2T9S',
    reproMissing: false,
    remediationSummary: 'Use parameterised queries for the search filter.',
    assetName: 'Shop API',
    wstgIds: ['WSTG-INPV-05'],
    consoleUrl: CONSOLE_URL,
    ...overrides,
  };
}

const CVSS4_VECTOR = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N';

beforeEach(() => {
  logs.info.mockClear();
  logs.warn.mockClear();
});

describe('buildTicketPayload title and labels', () => {
  it('builds the title from the convention and keeps the public id', () => {
    const payload = buildTicketPayload(fixture(), 'github', {});
    expect(payload.title).toBe(`[Blackwing] critical sqli on Shop API (${PUBLIC_ID})`);
  });

  it('truncates a long title in the middle and keeps the public id', () => {
    const payload = buildTicketPayload(
      fixture({ class: 'c'.repeat(120), assetName: 'a'.repeat(200) }),
      'github',
      {},
    );
    expect(payload.title.length).toBeLessThanOrEqual(TICKET_LIMITS.titleMax);
    expect(payload.title.endsWith(` (${PUBLIC_ID})`)).toBe(true);
    expect(payload.title).toContain('…');
  });

  it('never splits a surrogate pair when it truncates the title', () => {
    // The cut lands on the high surrogate of the first emoji in the asset name.
    const payload = buildTicketPayload(
      fixture({ class: 'a'.repeat(120), assetName: `${'x'.repeat(75)}${'😀'.repeat(20)}` }),
      'github',
      {},
    );
    expect(payload.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(payload.title.length).toBeLessThanOrEqual(TICKET_LIMITS.titleMax);
    expect(payload.title).toContain('…');
  });

  it('adds the finding marker, the blackwing label, defaults and class labels, without duplicates', () => {
    const payload = buildTicketPayload(fixture(), 'github', {
      defaultLabels: ['security', 'blackwing'],
      classLabels: { sqli: ['injection', 'security'] },
    });
    expect(payload.labels).toEqual([
      'security',
      'blackwing',
      `finding:${PUBLIC_ID}`,
      'severity:critical',
      'injection',
    ]);
  });

  it('is deterministic: the same finding and config give the same payload', () => {
    const config = { defaultLabels: ['security'] };
    expect(buildTicketPayload(fixture(), 'jira', config)).toEqual(
      buildTicketPayload(fixture(), 'jira', config),
    );
  });

  it('does not resolve a class named like an Object prototype member to inherited properties', () => {
    const payload = buildTicketPayload(fixture({ class: 'constructor' }), 'github', {});
    expect(payload.labels.every((label) => typeof label === 'string')).toBe(true);
    expect(payload.labels).not.toContain('function Object() { [native code] }');
  });
});

describe('severity to provider priority and label', () => {
  it.each([
    ['critical', 'Highest'],
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
    ['none', 'Low'],
  ] as const)('maps %s to the Jira priority %s', (band, priority) => {
    const payload = buildTicketPayload(
      fixture({ severity: { cvss4Vector: CVSS4_VECTOR, score: 0, band, cvss31Vector: null } }),
      'jira',
      {},
    );
    expect(payload.priority).toBe(priority);
    expect(payload.severity).toBe(band);
    expect(payload.labels).not.toContain(`severity:${band}`);
  });

  it.each(['github', 'gitlab'] as const)(
    'gives %s a severity label and no priority',
    (provider) => {
      const payload = buildTicketPayload(fixture(), provider, {});
      expect(payload.priority).toBeUndefined();
      expect(payload.labels).toContain('severity:critical');
    },
  );

  it('applies a Jira priority override', () => {
    const payload = buildTicketPayload(fixture(), 'jira', {
      priorityOverrides: { critical: 'Blocker' },
    });
    expect(payload.priority).toBe('Blocker');
  });

  it('applies a GitHub and GitLab severity label override', () => {
    const payload = buildTicketPayload(fixture(), 'gitlab', {
      severityLabelOverrides: { critical: 'sev::1' },
    });
    expect(payload.labels).toContain('sev::1');
    expect(payload.labels).not.toContain('severity:critical');
  });

  it('ignores a priority override for a provider that has no priority', () => {
    const payload = buildTicketPayload(fixture(), 'github', {
      priorityOverrides: { critical: 'Blocker' },
    });
    expect(payload.priority).toBeUndefined();
  });

  it('refuses a finding that is not scored', () => {
    expect(() => buildTicketPayload(fixture({ severity: null }), 'jira', {})).toThrow(
      ConnectorValidationError,
    );
  });
});

describe('body (Markdown)', () => {
  it('carries CVSS, CWE, OWASP, WSTG, location, the console link and the repro reference', () => {
    const body = buildTicketPayload(fixture(), 'github', {}).bodyMarkdown;
    expect(body).toContain('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N');
    expect(body).toContain('Score: 9.3 (critical)');
    expect(body).toContain('- OWASP: A03');
    expect(body).toContain('- CWE: CWE-89');
    expect(body).toContain('- WSTG: WSTG-INPV-05');
    expect(body).toContain('- ASVS: v5.0.0-1.2.5');
    expect(body).toContain('- Method: `GET`');
    expect(body).toContain('- URL template: `/api/products/{id}/search`');
    expect(body).toContain('- Parameter: `q`');
    expect(body).toContain(`[${PUBLIC_ID}](${CONSOLE_URL})`);
    expect(body).toContain('- Repro bundle: `rpa_01J8ZQ6W0Y5Q7KXP4V3BMZ2T9S`');
    expect(body).toContain('Reproduce offline');
  });

  it('keeps unicode in finding content verbatim', () => {
    const text = 'Naïve café — 日本語 🔐 résumé';
    const body = buildTicketPayload(fixture({ description: text }), 'github', {}).bodyMarkdown;
    expect(body).toContain(text);
  });

  it('never carries raw evidence references, payloads or step lists', () => {
    const body = buildTicketPayload(fixture(), 'github', {}).bodyMarkdown;
    expect(body).not.toContain('evidence/0190f2a4');
    expect(body).not.toContain('raw-response.bin');
    expect(body).not.toMatch(/' OR |UNION SELECT|<script>|curl |\bpayload\b/i);
  });

  it('omits CWE, OWASP and WSTG lines cleanly and keeps the ticket', () => {
    const body = buildTicketPayload(
      fixture({ cweId: null, owaspCategory: null, wstgIds: [], asvsRefs: null }),
      'github',
      {},
    ).bodyMarkdown;
    expect(body).not.toContain('- CWE:');
    expect(body).not.toContain('- OWASP:');
    expect(body).not.toContain('- WSTG:');
    expect(body).not.toContain('## Classification');
    expect(body).toContain('## Severity');
  });

  it('says "repro pending" and points nowhere when the repro bundle is missing', () => {
    const missingRef = buildTicketPayload(
      fixture({ reproArtifactRef: null, reproMissing: true }),
      'github',
      {},
    );
    expect(missingRef.bodyMarkdown).toContain('Repro: pending, no repro bundle is attached yet.');
    expect(missingRef.bodyMarkdown).not.toContain('Repro bundle:');
    const flagged = buildTicketPayload(fixture({ reproMissing: true }), 'github', {});
    expect(flagged.bodyMarkdown).toContain('Repro: pending');
    expect(flagged.bodyMarkdown).not.toContain('rpa_01J8ZQ6W0Y5Q7KXP4V3BMZ2T9S');
  });

  it('states a pending write-up instead of an empty summary', () => {
    const body = buildTicketPayload(
      fixture({ description: null, narrativePending: true }),
      'github',
      {},
    ).bodyMarkdown;
    expect(body).toContain('_Summary pending: the write-up is not ready yet._');
  });

  it('keeps a Markdown code span intact when a location holds backticks', () => {
    const body = buildTicketPayload(
      fixture({
        location: { method: null, urlTemplate: null, parameter: 'a`b', file: null, line: null },
      }),
      'github',
      {},
    ).bodyMarkdown;
    expect(body).toContain('- Parameter: ``a`b``');
  });

  it('shows file and line for a white-box location', () => {
    const body = buildTicketPayload(
      fixture({
        location: {
          method: null,
          urlTemplate: '/api/x',
          parameter: null,
          file: 'src/search.ts',
          line: 42,
        },
      }),
      'github',
      {},
    ).bodyMarkdown;
    expect(body).toContain('- File: `src/search.ts:42`');
  });

  it('cuts the prose at the budget and points at the console for the full finding', () => {
    const finding = ticketFindingSchema.parse(fixture({ description: 'd'.repeat(2000) }));
    const body = renderTicketBody(finding, 'critical', 1500);
    expect(body.length).toBeLessThanOrEqual(1500);
    expect(body).toContain(`Truncated: the full write-up is in the console at ${CONSOLE_URL}`);
    expect(body).toContain(`[${PUBLIC_ID}](${CONSOLE_URL})`);
    expect(body).toContain(`<!-- blackwing:finding=${PUBLIC_ID} -->`);
  });
});

describe('dedup marker', () => {
  it('puts finding:<publicId> in the labels and the body marker in the body', () => {
    const payload = buildTicketPayload(fixture(), 'jira', {});
    expect(payload.labels).toContain(`finding:${PUBLIC_ID}`);
    expect(payload.bodyMarkdown).toContain(`<!-- blackwing:finding=${PUBLIC_ID} -->`);
  });
});

describe('custom fields', () => {
  it('maps a known logical field to the provider custom field id', () => {
    const payload = buildTicketPayload(fixture(), 'jira', {
      fieldIds: { cvss4Score: 'customfield_10042', cweId: 'customfield_10043' },
    });
    expect(payload.fields).toEqual({ customfield_10042: '9.3', customfield_10043: 'CWE-89' });
  });

  it('omits a field the finding does not have', () => {
    const payload = buildTicketPayload(fixture({ cweId: null }), 'jira', {
      fieldIds: { cweId: 'customfield_10043' },
    });
    expect(payload.fields).toBeUndefined();
  });

  it('ignores an unknown logical field with a logged warning, without failing', () => {
    const payload = buildTicketPayload(fixture(), 'jira', {
      fieldIds: { notAField: 'customfield_9999', severityBand: 'customfield_10044' },
    });
    expect(payload.fields).toEqual({ customfield_10044: 'critical' });
    expect(logs.warn).toHaveBeenCalledWith(
      { provider: 'jira', field: 'notAField' },
      'unknown ticket field mapping ignored',
    );
  });
});

describe('observability and failure', () => {
  it('counts each mapping under its provider and logs the finding, provider and band', () => {
    const seen: string[] = [];
    const metrics: ConnectorMappingMetrics = { mapped: (provider) => seen.push(provider) };
    buildTicketPayload(fixture(), 'gitlab', {}, metrics);
    expect(seen).toEqual(['gitlab']);
    expect(logs.info).toHaveBeenCalledWith(
      { findingPublicId: PUBLIC_ID, provider: 'gitlab', severityBand: 'critical' },
      'ticket payload mapped',
    );
  });

  it('refuses an unknown provider', () => {
    expect(() => buildTicketPayload(fixture(), 'bugzilla' as unknown as 'jira', {})).toThrow(
      ConnectorUnknownProviderError,
    );
  });

  it('refuses an invalid mapping config', () => {
    expect(() =>
      buildTicketPayload(fixture(), 'jira', {
        unexpected: true,
      } as unknown as TicketMappingConfigInput),
    ).toThrow(ConnectorValidationError);
  });

  it('refuses a console link that could break out of the Markdown link', () => {
    expect(() =>
      buildTicketPayload(fixture({ consoleUrl: 'https://x.example/a)b' }), 'jira', {}),
    ).toThrow(ConnectorValidationError);
  });

  it('refuses a console link that is not http or https', () => {
    expect(() =>
      buildTicketPayload(fixture({ consoleUrl: 'ftp://files.example/finding' }), 'jira', {}),
    ).toThrow(ConnectorValidationError);
  });

  it('refuses a finding that breaks the report shape', () => {
    expect(() => buildTicketPayload(fixture({ publicId: 'run_bad' }), 'jira', {})).toThrow(
      ConnectorValidationError,
    );
  });

  it('does not echo finding values in its error message', () => {
    let message = 'no error thrown';
    try {
      buildTicketPayload(
        fixture({ assetName: `SECRET-ASSET-NAME-${'x'.repeat(5000)}` }),
        'jira',
        {},
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Finding cannot be mapped to a ticket');
  });
});
