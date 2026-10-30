import {
  type Catalogue,
  CatalogueError,
  defineCatalogue,
  entryCountsByClass,
} from './catalogue.js';
import { pathOf, tokens } from './tokens.js';

import type { SurfaceNode } from '../surface/write.js';

/**
 * The infrastructure and configuration test-case catalogue (INFRASPEC-002, #707): the single source of truth for
 * which classes the infrastructure specialist implements (INFRASPEC-003..008). Each entry names the class, its
 * standard ids, the declared oracle, the negative control, the intrusiveness class, a budget hint and the surface
 * nodes it applies to. It carries no payloads, no credential values and no exploitation steps. Default credentials
 * are confirmed by reference through the Session Manager (§8.7), never by a list of passwords.
 */

/** Metric incremented at load: entries per intrusiveness class. */
export const INFRA_CATALOGUE_METRIC = 'infra_catalogue_entries_total';
export const INFRA_CATALOGUE_METRIC_LABELS = ['class'] as const;

/** Infrastructure classes never mutate state (§8.3): only passive and active-safe classes are catalogued. */
const INFRA_INTRUSIVENESS = new Set(['passive', 'active_safe']);

/** Ports and service names that carry TLS (port numbers held as text, one per entry). */
const TLS_PORTS = new Set(['443', '465', '563', '636', '853', '989', '990', '993', '995', '8443']);
const TLS_SERVICE_NAMES = new Set([
  'https',
  'ssl',
  'tls',
  'ldaps',
  'imaps',
  'pop3s',
  'smtps',
  'ftps',
  'submissions',
]);

/** Words in a path or product name that mark an administrative interface. */
const ADMIN_TOKENS = new Set([
  'admin',
  'administrator',
  'administration',
  'adminer',
  'manager',
  'console',
  'dashboard',
  'phpmyadmin',
  'webmin',
  'cpanel',
  'actuator',
]);

/** Services whose sign-in can be reached with reference credentials (default-credential class). */
const CREDENTIALED_SERVICES = new Set([
  'ssh',
  'telnet',
  'ftp',
  'smb',
  'rdp',
  'vnc',
  'ldap',
  'snmp',
  'mysql',
  'postgresql',
  'mssql',
  'redis',
  'mongodb',
]);

const isService = (node: SurfaceNode): node is Extract<SurfaceNode, { type: 'service' }> =>
  node.type === 'service';
const isEndpoint = (node: SurfaceNode): node is Extract<SurfaceNode, { type: 'endpoint' }> =>
  node.type === 'endpoint';
const isTechnology = (node: SurfaceNode): node is Extract<SurfaceNode, { type: 'technology' }> =>
  node.type === 'technology';

const tlsService = (node: SurfaceNode): boolean =>
  isService(node) &&
  node.proto === 'tcp' &&
  (TLS_PORTS.has(String(node.port)) || TLS_SERVICE_NAMES.has((node.name ?? '').toLowerCase()));
const httpsEndpoint = (node: SurfaceNode): boolean =>
  isEndpoint(node) && /^https:\/\//i.test(node.url);
const adminSurface = (node: SurfaceNode): boolean =>
  (isEndpoint(node) && tokens(pathOf(node.url)).some((token) => ADMIN_TOKENS.has(token))) ||
  (isTechnology(node) && tokens(node.product).some((token) => ADMIN_TOKENS.has(token)));
const anyEndpoint = isEndpoint;
const knownVersion = (node: SurfaceNode): boolean =>
  isTechnology(node) && node.version !== undefined;
const credentialedService = (node: SurfaceNode): boolean =>
  isService(node) && CREDENTIALED_SERVICES.has((node.name ?? '').toLowerCase());

/** Rejects any entry whose intrusiveness is outside the infrastructure set (`state_changing` or `destructive`). */
export function assertInfraIntrusiveness(catalogue: Catalogue): Catalogue {
  for (const entry of catalogue.entries) {
    if (!INFRA_INTRUSIVENESS.has(entry.intrusiveness)) {
      throw new CatalogueError(
        `${entry.id}: intrusiveness ${entry.intrusiveness} is not allowed in the infra catalogue`,
      );
    }
  }
  return catalogue;
}

/** The pinned infrastructure catalogue. Building it validates every entry; a stale standard id fails the import. */
export const INFRA_CATALOGUE: Catalogue = assertInfraIntrusiveness(
  defineCatalogue('1.0.0', [
    {
      id: 'infra.tls.posture',
      title: 'TLS protocol and cipher posture',
      wstg: ['WSTG-CRYP-01'],
      cwe: ['CWE-326', 'CWE-327', 'CWE-295'],
      owasp: ['A02'],
      oracleType: 'config_signature',
      negativeControlTemplate: {
        strategy: 'compliant_variant',
        oracleType: 'config_signature',
        description:
          'Check a host with a current TLS configuration; no weak-protocol or weak-cipher signature may match.',
      },
      intrusiveness: 'active_safe',
      budgetHint: { maxRequests: 60, maxRps: 2 },
      appliesTo: (node: SurfaceNode) => tlsService(node) || httpsEndpoint(node),
    },
    {
      id: 'infra.config.admin_interface',
      title: 'Exposed administrative interface',
      wstg: ['WSTG-CONF-05'],
      cwe: ['CWE-668', 'CWE-1188'],
      owasp: ['A05'],
      oracleType: 'status_diff',
      negativeControlTemplate: {
        strategy: 'benign_value',
        oracleType: 'status_diff',
        description:
          'Request a random non-existent path of the same shape; its response must match the not-found baseline.',
      },
      intrusiveness: 'active_safe',
      budgetHint: { maxRequests: 30, maxRps: 2 },
      appliesTo: adminSurface,
    },
    {
      id: 'infra.config.exposure',
      title: 'Directory listing, dangerous HTTP methods and exposed sensitive files',
      wstg: ['WSTG-CONF-02', 'WSTG-CONF-04', 'WSTG-CONF-06'],
      cwe: ['CWE-538', 'CWE-16'],
      owasp: ['A05'],
      oracleType: 'config_signature',
      negativeControlTemplate: {
        strategy: 'benign_value',
        oracleType: 'config_signature',
        description:
          'Request a random non-existent file in the same directory; no listing or sensitive-file signature may match.',
      },
      intrusiveness: 'active_safe',
      budgetHint: { maxRequests: 40, maxRps: 2 },
      appliesTo: anyEndpoint,
    },
    {
      id: 'infra.component.known_vulnerable_version',
      title: 'Component version with a known vulnerability',
      wstg: [],
      cwe: ['CWE-1035', 'CWE-1104'],
      owasp: ['A06'],
      oracleType: 'version_cve',
      negativeControlTemplate: {
        strategy: 'compliant_variant',
        oracleType: 'version_cve',
        description:
          'Compare the identified version with a patched release of the same product; the advisory must not match.',
      },
      intrusiveness: 'passive',
      budgetHint: { maxRequests: 50, maxRps: 5 },
      appliesTo: knownVersion,
    },
    {
      id: 'infra.auth.default_credentials',
      title: 'Default or weak credentials (confirmed by reference)',
      wstg: ['WSTG-ATHN-02'],
      cwe: ['CWE-1392', 'CWE-521'],
      owasp: ['A07'],
      oracleType: 'status_diff',
      requiresReferenceCredentials: true,
      negativeControlTemplate: {
        strategy: 'benign_value',
        oracleType: 'status_diff',
        description:
          'Attempt a sign-in with an unknown account reference; it must be refused with the baseline response.',
      },
      intrusiveness: 'active_safe',
      budgetHint: { maxRequests: 5, maxRps: 1 },
      appliesTo: credentialedService,
    },
  ]),
);

/** Metric samples for {@link INFRA_CATALOGUE_METRIC}, to emit once at load. */
export const infraCatalogueMetricSamples = (): ReturnType<typeof entryCountsByClass> =>
  entryCountsByClass(INFRA_CATALOGUE);
