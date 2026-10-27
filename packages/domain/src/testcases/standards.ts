/**
 * Minimal standards reference tables behind the test-case catalogues (WEBAPI-001, #682).
 *
 * This is the checked-in subset of the CWE / OWASP / WSTG identifiers the catalogues reference. The full,
 * versioned CWE catalogue and the OWASP mapping data are owned by INTEL-006 (#503), which will replace
 * these tables behind the same predicates. Editions are explicit and never inferred: OWASP Top 10 2021,
 * OWASP API Security Top 10 2023 and the OWASP Web Security Testing Guide. An identifier that is not in
 * a table is unknown (retired or mistyped), and a catalogue that references it fails to build.
 */

/** OWASP Top 10 2021 (`A01`..`A10`). */
const OWASP_TOP10_2021: Readonly<Record<string, string>> = Object.freeze({
  A01: 'Broken Access Control',
  A02: 'Cryptographic Failures',
  A03: 'Injection',
  A04: 'Insecure Design',
  A05: 'Security Misconfiguration',
  A06: 'Vulnerable and Outdated Components',
  A07: 'Identification and Authentication Failures',
  A08: 'Software and Data Integrity Failures',
  A09: 'Security Logging and Monitoring Failures',
  A10: 'Server-Side Request Forgery',
});

/** OWASP API Security Top 10 2023 (`API1`..`API10`). */
const OWASP_API_TOP10_2023: Readonly<Record<string, string>> = Object.freeze({
  API1: 'Broken Object Level Authorization',
  API2: 'Broken Authentication',
  API3: 'Broken Object Property Level Authorization',
  API4: 'Unrestricted Resource Consumption',
  API5: 'Broken Function Level Authorization',
  API6: 'Unrestricted Access to Sensitive Business Flows',
  API7: 'Server Side Request Forgery',
  API8: 'Security Misconfiguration',
  API9: 'Improper Inventory Management',
  API10: 'Unsafe Consumption of APIs',
});

/** CWE ids the web/API catalogue references, with their MITRE names. */
const CWE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'CWE-22': 'Improper Limitation of a Pathname to a Restricted Directory',
  'CWE-78': 'Improper Neutralization of Special Elements used in an OS Command',
  'CWE-79': 'Improper Neutralization of Input During Web Page Generation',
  'CWE-89': 'Improper Neutralization of Special Elements used in an SQL Command',
  'CWE-90': 'Improper Neutralization of Special Elements used in an LDAP Query',
  'CWE-200': 'Exposure of Sensitive Information to an Unauthorized Actor',
  'CWE-209': 'Generation of Error Message Containing Sensitive Information',
  'CWE-434': 'Unrestricted Upload of File with Dangerous Type',
  'CWE-525': 'Use of Web Browser Cache Containing Sensitive Information',
  'CWE-601': 'URL Redirection to Untrusted Site',
  'CWE-611': 'Improper Restriction of XML External Entity Reference',
  'CWE-614': "Sensitive Cookie in HTTPS Session Without 'Secure' Attribute",
  'CWE-693': 'Protection Mechanism Failure',
  'CWE-915': 'Improperly Controlled Modification of Dynamically-Determined Object Attributes',
  'CWE-918': 'Server-Side Request Forgery',
  'CWE-942': 'Permissive Cross-domain Policy with Untrusted Domains',
  'CWE-943': 'Improper Neutralization of Special Elements in Data Query Logic',
  'CWE-1004': "Sensitive Cookie Without 'HttpOnly' Flag",
  'CWE-1336': 'Improper Neutralization of Special Elements Used in a Template Engine',
});

/** OWASP Web Security Testing Guide test ids the web/API catalogue references. */
const WSTG_TESTS: Readonly<Record<string, string>> = Object.freeze({
  'WSTG-ATHN-06': 'Testing for Browser Cache Weaknesses',
  'WSTG-ATHZ-01': 'Testing Directory Traversal File Include',
  'WSTG-APIT-01': 'Testing GraphQL',
  'WSTG-BUSL-09': 'Test Upload of Malicious Files',
  'WSTG-CLNT-01': 'Testing for DOM-Based Cross Site Scripting',
  'WSTG-CLNT-04': 'Testing for Client-side URL Redirect',
  'WSTG-CLNT-07': 'Testing Cross Origin Resource Sharing',
  'WSTG-CONF-07': 'Test HTTP Strict Transport Security',
  'WSTG-CONF-12': 'Test for Content Security Policy',
  'WSTG-ERRH-01': 'Testing for Improper Error Handling',
  'WSTG-ERRH-02': 'Testing for Stack Traces',
  'WSTG-INPV-01': 'Testing for Reflected Cross Site Scripting',
  'WSTG-INPV-05': 'Testing for SQL Injection',
  'WSTG-INPV-06': 'Testing for LDAP Injection',
  'WSTG-INPV-07': 'Testing for XML Injection',
  'WSTG-INPV-12': 'Testing for Command Injection',
  'WSTG-INPV-18': 'Testing for Server-side Template Injection',
  'WSTG-INPV-19': 'Testing for Server-Side Request Forgery',
  'WSTG-SESS-02': 'Testing for Cookies Attributes',
});

const has = (table: Readonly<Record<string, string>>, id: string): boolean =>
  Object.hasOwn(table, id);

/** True when `id` is a known CWE id (`CWE-<n>`). */
export const isKnownCwe = (id: string): boolean => has(CWE_NAMES, id);
/** True when `id` is a known OWASP Top 10 2021 category (`A01`..`A10`). */
export const isKnownOwaspTop10 = (id: string): boolean => has(OWASP_TOP10_2021, id);
/** True when `id` is a known OWASP API Security Top 10 2023 category (`API1`..`API10`). */
export const isKnownApiTop10 = (id: string): boolean => has(OWASP_API_TOP10_2023, id);
/** True when `id` is a known WSTG test id. */
export const isKnownWstg = (id: string): boolean => has(WSTG_TESTS, id);
