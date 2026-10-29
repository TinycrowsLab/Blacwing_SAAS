// DEMO-STORY: the pinned test case of GitHub issue #881 (Juice Shop SQL injection, product search).
// The planner, specialist and validator stubs of the demo all reference this one id, endpoint and oracle.
// The probe is benign: one single quote breaks the SQL syntax and the error signature shows in the response.
// No data is extracted and nothing is weaponised. The target must be the verified local lab asset.

export const DEMO_TEST_CASE = Object.freeze({
  id: 'webapi.injection.sql',
  title: 'SQL injection in product search',
  wstg: 'WSTG-INPV-05',
  cwe: 'CWE-89',
  owasp: 'A03:2021-Injection',
  /** Intrusiveness class of the case; a request must allow at least this (passive < active_safe). */
  intrusiveness: 'active_safe' as const,
  method: 'GET',
  pathPrefix: '/rest/products/search',
  parameter: 'q',
  probe: {
    value: "apple'",
    label: 'Detection probe: one single quote breaks the SQL syntax (benign)',
  },
  negativeControl: {
    value: 'apple',
    label: 'Negative control: an ordinary search term must not trigger the oracle',
  },
  oracle: {
    id: 'oracle.webapi.injection.sql.error_signature.v1',
    type: 'error_signature' as const,
    declaredAt: '2026-10-29T00:00:00.000Z',
    params: { signature: 'SQLITE_ERROR' },
  },
  replayCount: 2,
  /** Lab image the story was recorded against. The runner records the live version in the run pins. */
  labImage:
    'bkimminich/juice-shop:v17.1.1@sha256:9e437b456e444ff001d1663e4f6f05c796fe02f1058dd2651d6791a15b43dfeb',
});

export type DemoTestCase = typeof DEMO_TEST_CASE;

/** Intrusiveness order for the demo: a request class must be at least the case class. */
export const DEMO_INTRUSIVENESS = ['passive', 'active_safe'] as const;
export type DemoIntrusiveness = (typeof DEMO_INTRUSIVENESS)[number];

/** Classes the demo refuses outright (state-changing and destructive are never allowed; §8). */
export const REFUSED_DEMO_CLASSES = ['state_changing', 'destructive'] as const;
