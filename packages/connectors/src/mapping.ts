// Ticket mapping (CONNECT-002, #767). `buildTicketPayload` turns one released finding into the provider-neutral
// `TicketPayload` a connector pushes: title, a standards-rich Markdown body, severity mapped to a provider priority or
// label, labels (including the `finding:<publicId>` dedup marker) and optional custom fields. It is pure and
// deterministic: the same finding and config always give the same payload, which idempotent dedup (CONNECT-004) needs.
// The body stays at engineering altitude. It cites standards and the repro bundle reference and never carries
// payloads or step-by-step attack instructions (AUTHOR_BRIEF altitude rule, CONTEXT_PACK §8.7).

import { z } from 'zod';

import {
  cvssSeverityBandSchema,
  type CvssSeverityBand,
  LIMITS,
  labelSchema,
  reportFindingSchema,
} from '@blackwing/contracts';
import { createLogger } from '@blackwing/logger';

import { ConnectorUnknownProviderError, ConnectorValidationError } from './errors.js';
import { TICKET_LIMITS, ticketPayloadSchema, type TicketPayload } from './types.js';

const log = createLogger('@blackwing/connectors');

/** Providers the mapping knows. Jira takes a priority; GitHub and GitLab take `severity:<band>` labels. */
export const TICKET_MAPPING_PROVIDERS = ['jira', 'github', 'gitlab'] as const;
export type TicketMappingProvider = (typeof TICKET_MAPPING_PROVIDERS)[number];
const providerSchema = z.enum(TICKET_MAPPING_PROVIDERS);

/** Jira priority per CVSS band. `none` (score 0) has no Jira priority of its own and maps to the lowest one. */
const JIRA_PRIORITY: Readonly<Record<CvssSeverityBand, string>> = Object.freeze({
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'Low',
});

/** Logical finding values a `fieldIds` entry may map to a provider custom field. Anything else is ignored. */
const TICKET_FIELD_NAMES = [
  'assetName',
  'findingPublicId',
  'consoleUrl',
  'cvss4Vector',
  'cvss4Score',
  'severityBand',
  'cweId',
  'owaspCategory',
  'wstgIds',
] as const;
type TicketFieldName = (typeof TICKET_FIELD_NAMES)[number];
const TICKET_FIELD_NAME_SET: ReadonlySet<string> = new Set<string>(TICKET_FIELD_NAMES);

const MAX_WSTG_IDS = 16;
const SECTION_BREAK = '\n\n';
const WSTG_ID = /^WSTG-[A-Z]{4}-[0-9]{2}$/;

/**
 * The finding view the mapping reads. It is the released-finding report shape (`ReportFinding`, the same fields every
 * report renders, so the mapping and the report cannot disagree on standards) plus what a ticket needs beyond it: the
 * asset name, the WSTG test ids and the console link. The caller builds it from redaction-safe finding data.
 */
export const ticketFindingSchema = reportFindingSchema.extend({
  assetName: labelSchema,
  wstgIds: z.array(z.string().regex(WSTG_ID, 'must look like WSTG-XXXX-NN')).max(MAX_WSTG_IDS),
  consoleUrl: z
    .url({ protocol: /^https?$/ })
    .max(LIMITS.urlMax)
    .regex(/^[^\s()<>]+$/, 'must not contain spaces, parentheses or angle brackets'),
});
export type TicketFindingInput = z.input<typeof ticketFindingSchema>;

const labelValueSchema = z.string().trim().min(1).max(TICKET_LIMITS.labelMax);
const bandValueSchema = z.partialRecord(cvssSeverityBandSchema, labelValueSchema);

/**
 * Per-connector mapping configuration (`default_mapping_id`). Every rule is optional. Overrides are keyed by CVSS band:
 * `priorityOverrides` replaces the Jira priority, `severityLabelOverrides` replaces the GitHub and GitLab label.
 */
export const ticketMappingConfigSchema = z.strictObject({
  /** Labels added to every ticket, before the built-in ones. */
  defaultLabels: z.array(labelValueSchema).max(TICKET_LIMITS.labelsMax).default([]),
  /** Extra labels per finding class (the class string, as the finding stores it). */
  classLabels: z
    .record(
      z.string().min(1).max(LIMITS.shortTextMax),
      z.array(labelValueSchema).max(TICKET_LIMITS.labelsMax),
    )
    .default({}),
  priorityOverrides: bandValueSchema.default({}),
  severityLabelOverrides: bandValueSchema.default({}),
  /** Logical field name (see {@link TICKET_FIELD_NAMES}) to the provider's custom field id, for example a Jira id. */
  fieldIds: z
    .record(
      z.string().min(1).max(TICKET_LIMITS.labelMax),
      z.string().trim().min(1).max(TICKET_LIMITS.labelMax),
    )
    .default({}),
});
export type TicketMappingConfigInput = z.input<typeof ticketMappingConfigSchema>;

/**
 * Counter port for `connector_mapping_total{provider}`. The push worker supplies the exporter; the default records
 * nothing.
 */
export interface ConnectorMappingMetrics {
  mapped(provider: TicketMappingProvider): void;
}

export const noopConnectorMappingMetrics: ConnectorMappingMetrics = {
  mapped: () => undefined,
};

/**
 * Builds the ticket payload for one released finding. Throws `CONNECTOR_UNKNOWN_PROVIDER` for an unknown provider and
 * `CONNECTOR_VALIDATION` when the finding is not scored, the config is invalid or the payload breaks a connector
 * rule. Errors name the rule only; they never echo finding or config values.
 */
export function buildTicketPayload(
  finding: TicketFindingInput,
  provider: TicketMappingProvider,
  mappingConfig: TicketMappingConfigInput,
  metrics: ConnectorMappingMetrics = noopConnectorMappingMetrics,
): TicketPayload {
  const providerResult = providerSchema.safeParse(provider);
  if (!providerResult.success)
    throw new ConnectorUnknownProviderError('Unknown ticket connector provider');
  const parsedProvider = providerResult.data;

  const configResult = ticketMappingConfigSchema.safeParse(mappingConfig);
  if (!configResult.success)
    throw new ConnectorValidationError('Invalid ticket mapping configuration');
  const config = configResult.data;

  const findingResult = ticketFindingSchema.safeParse(finding);
  if (!findingResult.success)
    throw new ConnectorValidationError('Finding cannot be mapped to a ticket');
  const f = findingResult.data;

  const severity = f.severity;
  if (severity === null)
    throw new ConnectorValidationError('Finding is not scored; it cannot be mapped to a ticket');
  const band = severity.band;

  const priority =
    parsedProvider === 'jira'
      ? (own(config.priorityOverrides, band) ?? JIRA_PRIORITY[band])
      : undefined;

  const payloadResult = ticketPayloadSchema.safeParse({
    title: titleFor(band, f.class, f.assetName, f.publicId),
    bodyMarkdown: renderTicketBody(f, band, TICKET_LIMITS.bodyMarkdownMax),
    severity: band,
    labels: labelsFor(parsedProvider, f.publicId, f.class, band, config),
    ...(priority === undefined ? {} : { priority }),
    ...customFieldsFor(parsedProvider, f, band, config),
  });
  if (!payloadResult.success)
    throw new ConnectorValidationError('Ticket payload breaks a connector rule');

  metrics.mapped(parsedProvider);
  log.info(
    { findingPublicId: f.publicId, provider: parsedProvider, severityBand: band },
    'ticket payload mapped',
  );
  return payloadResult.data;
}

/** `[Blackwing] <band> <class> on <asset> (<publicId>)`, truncated in the middle so the public id always survives. */
function titleFor(
  band: CvssSeverityBand,
  findingClass: string,
  assetName: string,
  publicId: string,
): string {
  const prefix = `[Blackwing] ${band} `;
  const suffix = ` (${publicId})`;
  const room = TICKET_LIMITS.titleMax - prefix.length - suffix.length;
  return `${prefix}${truncate(`${findingClass} on ${assetName}`, room)}${suffix}`;
}

/**
 * Labels in a fixed order: defaults, `blackwing`, the `finding:<publicId>` dedup marker, the severity label (GitHub and
 * GitLab only) and the class labels. Duplicates keep their first position.
 */
function labelsFor(
  provider: TicketMappingProvider,
  publicId: string,
  findingClass: string,
  band: CvssSeverityBand,
  config: z.infer<typeof ticketMappingConfigSchema>,
): string[] {
  const severityLabel =
    provider === 'jira' ? [] : [own(config.severityLabelOverrides, band) ?? `severity:${band}`];
  const classLabels = own(config.classLabels, findingClass) ?? [];
  return [
    ...new Set([
      ...config.defaultLabels,
      'blackwing',
      `finding:${publicId}`,
      ...severityLabel,
      ...classLabels,
    ]),
  ];
}

/**
 * Provider custom fields from `fieldIds`. A logical name the mapping does not know is skipped with a warning, and a
 * value the finding does not have is omitted. Values are cut to the field limit.
 */
function customFieldsFor(
  provider: TicketMappingProvider,
  f: z.infer<typeof ticketFindingSchema>,
  band: CvssSeverityBand,
  config: z.infer<typeof ticketMappingConfigSchema>,
): { fields?: Record<string, string> } {
  const severity = f.severity;
  const values: Readonly<Record<TicketFieldName, string | undefined>> = {
    assetName: f.assetName,
    findingPublicId: f.publicId,
    consoleUrl: f.consoleUrl,
    cvss4Vector: severity?.cvss4Vector,
    cvss4Score: severity === null ? undefined : String(severity.score),
    severityBand: band,
    cweId: f.cweId ?? undefined,
    owaspCategory: f.owaspCategory ?? undefined,
    wstgIds: f.wstgIds.length > 0 ? f.wstgIds.join(', ') : undefined,
  };
  const fields: Record<string, string> = {};
  for (const [logical, fieldId] of Object.entries(config.fieldIds)) {
    if (!TICKET_FIELD_NAME_SET.has(logical)) {
      log.warn({ provider, field: logical }, 'unknown ticket field mapping ignored');
      continue;
    }
    const value = values[logical as TicketFieldName];
    if (value === undefined) continue;
    fields[fieldId] = truncate(value, TICKET_LIMITS.fieldValueMax);
  }
  return Object.keys(fields).length > 0 ? { fields } : {};
}

/**
 * The Markdown body, sections in order: summary and prose first (the part that is cut when the body is longer than
 * `maxLength`), then severity, classification, location, status, repro and the console link. The contract caps each
 * prose field, so the cut is a guard for a larger budget; the console link in the notice always leads to the full text.
 */
export function renderTicketBody(
  f: z.infer<typeof ticketFindingSchema>,
  band: CvssSeverityBand,
  maxLength: number,
): string {
  const severity = f.severity;
  if (severity === null) throw new ConnectorValidationError('Finding is not scored');

  const prose: string[] = [
    '## Summary',
    '',
    f.description ??
      (f.narrativePending ? '_Summary pending: the write-up is not ready yet._' : ''),
  ];
  if (f.impact !== null) prose.push('', '### Impact', '', f.impact);
  if (f.evidenceNarrative !== null) prose.push('', '### Evidence', '', f.evidenceNarrative);
  if (f.remediationSummary !== null) prose.push('', '### Remediation', '', f.remediationSummary);

  const tail: string[] = [
    '## Severity',
    '',
    `- CVSS v4.0: ${inlineCode(severity.cvss4Vector)}`,
    `- Score: ${severity.score} (${band})`,
  ];
  if (severity.cvss31Vector !== null)
    tail.push(`- CVSS v3.1 (legacy): ${inlineCode(severity.cvss31Vector)}`);
  if (f.severityRationale !== null) tail.push(`- Rationale: ${f.severityRationale}`);

  const classification: string[] = [];
  if (f.owaspCategory !== null) classification.push(`- OWASP: ${f.owaspCategory}`);
  if (f.cweId !== null) classification.push(`- CWE: ${f.cweId}`);
  if (f.wstgIds.length > 0) classification.push(`- WSTG: ${f.wstgIds.join(', ')}`);
  if (f.asvsRefs !== null && f.asvsRefs.length > 0)
    classification.push(`- ASVS: ${f.asvsRefs.join(', ')}`);
  if (classification.length > 0) tail.push('', '## Classification', '', ...classification);

  const location = f.location;
  const where: string[] = [];
  if (location.method !== null) where.push(`- Method: ${inlineCode(location.method)}`);
  if (location.urlTemplate !== null)
    where.push(`- URL template: ${inlineCode(location.urlTemplate)}`);
  if (location.parameter !== null) where.push(`- Parameter: ${inlineCode(location.parameter)}`);
  if (location.file !== null)
    where.push(
      `- File: ${inlineCode(location.line === null ? location.file : `${location.file}:${location.line}`)}`,
    );
  if (where.length > 0) tail.push('', '## Location', '', ...where);

  const status: string[] = [];
  if (f.baselineStatus !== null) status.push(`- Baseline: ${f.baselineStatus}`);
  if (f.confidence !== null) status.push(`- Validator confidence: ${f.confidence.toFixed(2)}`);
  if (status.length > 0) tail.push('', '## Status', '', ...status);

  const reproReady = f.reproArtifactRef !== null && !f.reproMissing;
  tail.push(
    '',
    '## Repro',
    '',
    reproReady
      ? `- Repro bundle: ${inlineCode(f.reproArtifactRef ?? '')}`
      : '- Repro: pending, no repro bundle is attached yet.',
    '- Reproduce offline: open the repro bundle in an isolated lab. This ticket carries no payloads or steps.',
    '',
    '## Finding',
    '',
    `[${f.publicId}](${f.consoleUrl})`,
    '',
    `<!-- blackwing:finding=${f.publicId} -->`,
  );

  const proseText = prose.join('\n');
  const tailText = tail.join('\n');
  const full = `${proseText}${SECTION_BREAK}${tailText}`;
  if (full.length <= maxLength) return full;

  const notice = `> Truncated: the full write-up is in the console at ${f.consoleUrl}`;
  const room = maxLength - tailText.length - notice.length - 2 * SECTION_BREAK.length;
  return `${truncate(proseText, room)}${SECTION_BREAK}${notice}${SECTION_BREAK}${tailText}`;
}

/** Markdown code span that holds `value` as written, even when it contains backticks. Line breaks become spaces. */
function inlineCode(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ');
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Cuts `text` to at most `max` UTF-16 units, ending with an ellipsis, without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Own-property lookup, so a class or band named like an `Object.prototype` member never resolves to it. */
function own<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
