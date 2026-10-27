import { type Catalogue, defineCatalogue, entryCountsByClass } from './catalogue.js';

import type { SurfaceNode } from '../surface/write.js';

/**
 * The web/API test-case catalogue (WEBAPI-001, #682): the single source of truth for which classes
 * WEBAPI-003..009 implement. Each entry names the class, its standard ids, the declared oracle, the negative
 * control, the intrusiveness class, a budget hint and the surface nodes it applies to. It carries no
 * payloads and no exploitation steps: detection modules hold only benign probes bounded by the oracle.
 */

/** Metric incremented at load: entries per intrusiveness class. */
export const WEBAPI_CATALOGUE_METRIC = 'webapi_catalogue_entries_total';
export const WEBAPI_CATALOGUE_METRIC_LABELS = ['class'] as const;

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Lowercase word tokens of a name or path: `returnUrl`, `return_url` and `return-url` all give return, url. */
function tokens(text: string): readonly string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

const isParameter = (node: SurfaceNode): node is Extract<SurfaceNode, { type: 'parameter' }> =>
  node.type === 'parameter';
const isEndpoint = (node: SurfaceNode): node is Extract<SurfaceNode, { type: 'endpoint' }> =>
  node.type === 'endpoint';

/** A parameter whose name suggests one of `hints` (a URL, a file path and so on). */
const namedParameter =
  (hints: ReadonlySet<string>) =>
  (node: SurfaceNode): boolean =>
    isParameter(node) && tokens(node.name).some((token) => hints.has(token));

const urlLike = new Set([
  'url',
  'uri',
  'link',
  'href',
  'src',
  'dest',
  'destination',
  'target',
  'callback',
  'webhook',
  'host',
  'domain',
  'feed',
  'image',
  'proxy',
]);
const redirectLike = new Set([
  'redirect',
  'return',
  'next',
  'goto',
  'continue',
  'forward',
  'dest',
  'destination',
  'url',
  'uri',
  'target',
]);
const fileLike = new Set([
  'file',
  'filename',
  'path',
  'dir',
  'folder',
  'doc',
  'document',
  'template',
  'page',
  'include',
  'download',
  'attachment',
]);
const uploadLike = new Set([
  'upload',
  'uploads',
  'file',
  'files',
  'attachment',
  'avatar',
  'image',
  'import',
]);

const anyParameter = isParameter;
const anyEndpoint = isEndpoint;
const bodyEndpoint = (node: SurfaceNode): boolean =>
  isEndpoint(node) && BODY_METHODS.has(node.method.toUpperCase());
const uploadEndpoint = (node: SurfaceNode): boolean =>
  bodyEndpoint(node) &&
  isEndpoint(node) &&
  tokens(pathOf(node.url)).some((token) => uploadLike.has(token));
const graphqlEndpoint = (node: SurfaceNode): boolean =>
  isEndpoint(node) &&
  pathOf(node.url)
    .toLowerCase()
    .split('/')
    .some((segment) => segment === 'graphql' || segment === 'graphiql');

const inputControl = (description: string) => ({ strategy: 'benign_value', description }) as const;

/** The pinned web/API catalogue. Building it validates every entry; a stale standard id fails the import. */
export const WEBAPI_CATALOGUE: Catalogue = defineCatalogue('1.0.0', [
  {
    id: 'webapi.injection.sql',
    title: 'SQL injection',
    wstg: ['WSTG-INPV-05'],
    cwe: ['CWE-89'],
    owasp: ['A03'],
    oracleType: 'error_signature',
    negativeControlTemplate: {
      ...inputControl(
        'Replay with an ordinary value for the same parameter; no database error signature may appear.',
      ),
      oracleType: 'error_signature',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 40, maxRps: 5 },
    appliesTo: anyParameter,
  },
  {
    id: 'webapi.injection.os_command',
    title: 'OS command injection',
    wstg: ['WSTG-INPV-12'],
    cwe: ['CWE-78'],
    owasp: ['A03'],
    oracleType: 'timing_baseline',
    negativeControlTemplate: {
      ...inputControl(
        'Replay with an ordinary value; response time must stay within the baseline threshold.',
      ),
      oracleType: 'timing_baseline',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 60, maxRps: 2 },
    appliesTo: anyParameter,
  },
  {
    id: 'webapi.injection.ldap',
    title: 'LDAP injection',
    wstg: ['WSTG-INPV-06'],
    cwe: ['CWE-90'],
    owasp: ['A03'],
    oracleType: 'error_signature',
    negativeControlTemplate: {
      ...inputControl('Replay with an ordinary value; no directory error signature may appear.'),
      oracleType: 'error_signature',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 30, maxRps: 5 },
    appliesTo: anyParameter,
  },
  {
    id: 'webapi.injection.nosql',
    title: 'NoSQL / query-logic injection',
    wstg: ['WSTG-INPV-05'],
    cwe: ['CWE-943'],
    owasp: ['A03'],
    oracleType: 'status_diff',
    negativeControlTemplate: {
      ...inputControl(
        'Replay with an ordinary value; the response must match the recorded baseline.',
      ),
      oracleType: 'status_diff',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 30, maxRps: 5 },
    appliesTo: anyParameter,
  },
  {
    id: 'webapi.xss.client_side',
    title: 'Client-side script execution (cross-site scripting)',
    wstg: ['WSTG-INPV-01', 'WSTG-CLNT-01'],
    cwe: ['CWE-79'],
    owasp: ['A03'],
    oracleType: 'marker',
    negativeControlTemplate: {
      ...inputControl(
        'Replay with an inert value; the unique marker must not appear in an executable context.',
      ),
      oracleType: 'marker',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 30, maxRps: 5 },
    appliesTo: anyParameter,
  },
  {
    id: 'webapi.ssrf',
    title: 'Server-side request forgery',
    wstg: ['WSTG-INPV-19'],
    cwe: ['CWE-918'],
    owasp: ['A10'],
    apiTop10: ['API7'],
    oracleType: 'out_of_band',
    negativeControlTemplate: {
      strategy: 'unbound_interaction',
      oracleType: 'out_of_band',
      description:
        'Replay without the per-test interaction token; no correlated inbound interaction may arrive.',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 20, maxRps: 2 },
    appliesTo: namedParameter(urlLike),
  },
  {
    id: 'webapi.info.verbose_error',
    title: 'Verbose error and stack-trace disclosure',
    wstg: ['WSTG-ERRH-01', 'WSTG-ERRH-02'],
    cwe: ['CWE-209'],
    owasp: ['A05', 'A09'],
    oracleType: 'error_signature',
    negativeControlTemplate: {
      strategy: 'unmodified_request',
      oracleType: 'error_signature',
      description: 'Replay the unmodified request; no internal error signature may appear.',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 20, maxRps: 5 },
    appliesTo: anyEndpoint,
  },
  {
    id: 'webapi.info.sensitive_data',
    title: 'Sensitive data exposed in cacheable responses',
    wstg: ['WSTG-ATHN-06'],
    cwe: ['CWE-200', 'CWE-525'],
    owasp: ['A02'],
    oracleType: 'header_cookie_flag',
    negativeControlTemplate: {
      strategy: 'compliant_variant',
      oracleType: 'header_cookie_flag',
      description:
        'Check a public static resource that is expected to be cacheable; it must not match.',
    },
    intrusiveness: 'passive',
    budgetHint: { maxRequests: 50, maxRps: 5 },
    appliesTo: anyEndpoint,
  },
  {
    id: 'webapi.config.security_headers',
    title: 'Missing or weak security response headers',
    wstg: ['WSTG-CONF-07', 'WSTG-CONF-12'],
    cwe: ['CWE-693'],
    owasp: ['A05'],
    oracleType: 'header_cookie_flag',
    negativeControlTemplate: {
      strategy: 'compliant_variant',
      oracleType: 'header_cookie_flag',
      description:
        'Check a response known to carry the header with a compliant value; it must not match.',
    },
    intrusiveness: 'passive',
    budgetHint: { maxRequests: 50, maxRps: 5 },
    appliesTo: anyEndpoint,
  },
  {
    id: 'webapi.config.cookie_flags',
    title: 'Session cookie missing Secure or HttpOnly',
    wstg: ['WSTG-SESS-02'],
    cwe: ['CWE-614', 'CWE-1004'],
    owasp: ['A05'],
    oracleType: 'header_cookie_flag',
    negativeControlTemplate: {
      strategy: 'compliant_variant',
      oracleType: 'header_cookie_flag',
      description: 'Check a cookie known to carry the attribute; it must not match.',
    },
    intrusiveness: 'passive',
    budgetHint: { maxRequests: 50, maxRps: 5 },
    appliesTo: anyEndpoint,
  },
  {
    id: 'webapi.config.cors',
    title: 'Permissive cross-origin resource sharing',
    wstg: ['WSTG-CLNT-07'],
    cwe: ['CWE-942'],
    owasp: ['A05'],
    oracleType: 'header_cookie_flag',
    negativeControlTemplate: {
      strategy: 'compliant_variant',
      oracleType: 'header_cookie_flag',
      description:
        'Replay with an allow-listed origin; the permissive-origin condition must not match.',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 20, maxRps: 5 },
    appliesTo: anyEndpoint,
  },
  {
    id: 'webapi.xxe',
    title: 'XML external entity processing',
    wstg: ['WSTG-INPV-07'],
    cwe: ['CWE-611'],
    owasp: ['A05'],
    oracleType: 'out_of_band',
    negativeControlTemplate: {
      strategy: 'unbound_interaction',
      oracleType: 'out_of_band',
      description:
        'Replay a well-formed document without the per-test interaction token; no interaction may arrive.',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 20, maxRps: 2 },
    appliesTo: bodyEndpoint,
  },
  {
    id: 'webapi.ssti',
    title: 'Server-side template injection',
    wstg: ['WSTG-INPV-18'],
    cwe: ['CWE-1336'],
    owasp: ['A03'],
    oracleType: 'marker',
    negativeControlTemplate: {
      ...inputControl('Replay with a literal value; the evaluated marker must not appear.'),
      oracleType: 'marker',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 30, maxRps: 5 },
    appliesTo: anyParameter,
  },
  {
    id: 'webapi.path_traversal',
    title: 'Path traversal and arbitrary file read',
    wstg: ['WSTG-ATHZ-01'],
    cwe: ['CWE-22'],
    owasp: ['A01'],
    oracleType: 'file_read_marker',
    negativeControlTemplate: {
      ...inputControl('Replay with an ordinary file name; the benign sentinel must not appear.'),
      oracleType: 'file_read_marker',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 30, maxRps: 5 },
    appliesTo: namedParameter(fileLike),
  },
  {
    id: 'webapi.open_redirect',
    title: 'Open redirect',
    wstg: ['WSTG-CLNT-04'],
    cwe: ['CWE-601'],
    owasp: ['A01'],
    oracleType: 'status_diff',
    negativeControlTemplate: {
      ...inputControl(
        'Replay with an in-scope same-site target; the redirect must not leave the site.',
      ),
      oracleType: 'status_diff',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 20, maxRps: 5 },
    appliesTo: namedParameter(redirectLike),
  },
  {
    id: 'webapi.mass_assignment',
    title: 'Mass assignment (object property level authorization)',
    wstg: [],
    cwe: ['CWE-915'],
    owasp: [],
    apiTop10: ['API3'],
    oracleType: 'status_diff',
    negativeControlTemplate: {
      strategy: 'unmodified_request',
      oracleType: 'status_diff',
      description: 'Replay without the extra property; the protected property must be unchanged.',
    },
    intrusiveness: 'state_changing',
    budgetHint: { maxRequests: 20, maxRps: 2 },
    appliesTo: bodyEndpoint,
  },
  {
    id: 'webapi.file_upload',
    title: 'Unrestricted file upload (benign marker file)',
    wstg: ['WSTG-BUSL-09'],
    cwe: ['CWE-434'],
    owasp: ['A04'],
    oracleType: 'marker',
    negativeControlTemplate: {
      ...inputControl(
        'Upload an allowed file type; it must be accepted without the disallowed-type condition.',
      ),
      oracleType: 'marker',
    },
    intrusiveness: 'state_changing',
    budgetHint: { maxRequests: 10, maxRps: 1 },
    appliesTo: uploadEndpoint,
  },
  {
    id: 'webapi.graphql.exposure',
    title: 'GraphQL schema exposure and unsafe configuration',
    wstg: ['WSTG-APIT-01'],
    cwe: ['CWE-200'],
    owasp: ['A05'],
    apiTop10: ['API8', 'API9'],
    oracleType: 'status_diff',
    negativeControlTemplate: {
      strategy: 'unmodified_request',
      oracleType: 'status_diff',
      description: 'Replay an ordinary query; the response must match the recorded baseline.',
    },
    intrusiveness: 'active_safe',
    budgetHint: { maxRequests: 20, maxRps: 5 },
    appliesTo: graphqlEndpoint,
  },
]);

/** Metric samples for {@link WEBAPI_CATALOGUE_METRIC}, to emit once at load. */
export const webApiCatalogueMetricSamples = (): ReturnType<typeof entryCountsByClass> =>
  entryCountsByClass(WEBAPI_CATALOGUE);
