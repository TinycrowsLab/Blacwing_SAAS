/**
 * The §8 security-invariant matrix (CONTEXT_PACK §8, issue #805).
 *
 * Each invariant maps to the concrete tests that prove it. A reference is a repo-relative file plus a title
 * fragment that must appear in that file. The evaluation is static and deterministic: an invariant with no
 * owning test is a gap, a reference whose file or title no longer exists is broken, and an entry for an unknown
 * invariant is rejected. Any of these turns the matrix red. The file reader is injected, so the logic runs
 * without a repository. Verification only: the matrix asserts that controls exist and are exercised; it does not
 * exploit anything.
 */

export const SECURITY_INVARIANTS = [
  { id: '8.1', title: 'No target traffic without a valid, unexpired, signature-verified envelope' },
  { id: '8.2', title: 'Egress fails closed (policy, scope, DNS rebinding, private ranges)' },
  {
    id: '8.3',
    title: 'Destructive class is never allowed; state_changing needs a reversal-journal entry',
  },
  { id: '8.4', title: 'Separation of duties: requester is not approver' },
  { id: '8.5', title: 'Kill switch halts every in-scope agent within the SLO' },
  { id: '8.6', title: 'Tenant isolation everywhere' },
  { id: '8.7', title: 'Secrets never reach the model, the logs or the sandbox in plaintext' },
  { id: '8.8', title: 'Audit ledger is append-only and tamper-evident' },
  { id: '8.9', title: 'Pinned versions: every run records its pin set' },
  { id: '8.10', title: 'Ownership verification: an unverified asset cannot be targeted' },
  { id: '8.11', title: 'No model-dependent safety: every safety property is deterministic code' },
] as const;

interface TestRef {
  readonly file: string;
  readonly title: string;
}

export interface MatrixEntry {
  readonly id: string;
  readonly tests: readonly TestRef[];
}

/** Reads a repo-relative file; `null` when the file does not exist. */
export interface FileReader {
  readonly read: (file: string) => string | null;
}

type RefStatus = 'ok' | 'missing_file' | 'missing_title';

interface RefResult {
  readonly ref: TestRef;
  readonly status: RefStatus;
}

interface InvariantResult {
  readonly id: string;
  readonly title: string;
  readonly refs: readonly RefResult[];
  readonly status: 'covered' | 'gap';
}

export interface MatrixReport {
  readonly green: boolean;
  readonly invariants: readonly InvariantResult[];
  readonly gaps: readonly string[];
  readonly broken: readonly {
    readonly id: string;
    readonly ref: TestRef;
    readonly status: RefStatus;
  }[];
  readonly unknown: readonly string[];
}

export const INVARIANT_MATRIX: readonly MatrixEntry[] = [
  {
    id: '8.1',
    tests: [
      {
        file: 'apps/egress-gateway/internal/identity/verify_test.go',
        title: 'TestAuthenticateRejections',
      },
      {
        file: 'apps/egress-gateway/internal/identity/verify_test.go',
        title: 'TestVerifierUnreachableFailsClosed',
      },
      {
        file: 'packages/crypto/src/sa-verify.test.ts',
        title: 'reports NOT_YET_VALID before validFrom and EXPIRED at and after expiresAt',
      },
      {
        file: 'packages/crypto/src/sa-verify.test.ts',
        title: 'reports TAMPERED for any changed signed field',
      },
      {
        file: 'apps/worker/src/sa-bounds/sequence.test.ts',
        title: 'blocks egress first, then cancels sessions, then finalises the run as expired',
      },
    ],
  },
  {
    id: '8.2',
    tests: [
      { file: 'apps/egress-gateway/internal/netguard/guard_test.go', title: 'TestBlockedRanges' },
      { file: 'apps/egress-gateway/internal/netguard/guard_test.go', title: 'TestDialControl' },
      {
        file: 'apps/egress-gateway/internal/proxy/redirect_test.go',
        title: 'TestRedirectFromLabToPrivateIsOutOfScope',
      },
      {
        file: 'apps/egress-gateway/internal/dnsresolve/resolver_test.go',
        title: 'TestRebindingKeepsFirstPinnedIP',
      },
      {
        file: 'apps/egress-gateway/internal/dnsresolve/resolver_test.go',
        title: 'TestOutOfScopeHostMakesNoUpstreamQuery',
      },
      {
        file: 'apps/egress-gateway/internal/scope/scope_test.go',
        title: 'TestMalformedTargetsAreDenied',
      },
    ],
  },
  {
    id: '8.3',
    tests: [
      {
        file: 'packages/db/src/authorisation.constraints.int.test.ts',
        title: 'refuses destructive as a ceiling (§8.3)',
      },
      {
        file: 'packages/contracts/src/intrusiveness.test.ts',
        title: 'rejects a destructive ceiling with SCOPE_DESTRUCTIVE_FORBIDDEN',
      },
      {
        file: 'packages/contracts/src/validation/replay-spec.test.ts',
        title: 'rejects a destructive intrusiveness class (never authorisable, §8.3)',
      },
      {
        file: 'apps/worker/src/run/planning/activities.test.ts',
        title: 'rejects a destructive case with CLASS_FORBIDDEN and persists nothing (§8.3)',
      },
      {
        file: 'apps/api/src/broker/pdp.test.ts',
        title: 'denies a state_changing call without a reversal-journal entry (§8.3)',
      },
      {
        file: 'apps/agent-runtime/src/session/resume.test.ts',
        title:
          'denies an approved state-changing call with no reversal-journal entry, regardless of approval (§8.3)',
      },
    ],
  },
  {
    id: '8.4',
    tests: [
      {
        file: 'apps/api/src/authorisations/service.test.ts',
        title: 'refuses the requester approving their own SA with AUTHZ_SOD_VIOLATION (403)',
      },
      {
        file: 'apps/api/src/gate1/policy.test.ts',
        title:
          'denies the requester deciding their own plan, even with the approve permission (SoD)',
      },
      {
        file: 'packages/db/src/authz-gate-decision.int.test.ts',
        title: 'refuses a Gate 1 approval where the actor is the requester, on a direct write',
      },
      {
        file: 'packages/db/src/authz-gate-decision.int.test.ts',
        title: 'refuses a Gate 2 approval where the actor is the requester, on a direct write',
      },
    ],
  },
  {
    id: '8.5',
    tests: [
      {
        file: 'apps/worker/src/kill/chaos/kill-slo.chaos.test.ts',
        title: 'halts every kill and keeps the egress and full-halt p99 inside budget',
      },
      {
        file: 'apps/worker/src/kill/chaos/kill-slo.chaos.test.ts',
        title: 'kill.chaos.failclosed: egress unreachable',
      },
      {
        file: 'apps/worker/src/kill/chaos/kill-slo.chaos.test.ts',
        title:
          'a delayed egress ack past the 2 s budget still denies traffic before the ack arrives',
      },
    ],
  },
  {
    id: '8.6',
    tests: [
      {
        file: 'packages/db/src/audit.rls.int.test.ts',
        title: 'tenant B cannot read tenant A rows and has its own chain',
      },
      {
        file: 'packages/db/src/kill.rls.int.test.ts',
        title: 'tenant A cannot write a %s row for tenant B',
      },
      {
        file: 'packages/db/src/authorisation.constraints.int.test.ts',
        title: 'refuses a row written under another tenant context (WITH CHECK, §8.6)',
      },
      {
        file: 'apps/api/src/audit-query/postgres.int.test.ts',
        title: 'never returns another tenant rows, even for an id that exists there (RLS)',
      },
      {
        file: 'apps/api/src/graphql/assets.rls.int.test.ts',
        title: "lists only the caller tenant's live assets",
      },
      {
        file: 'apps/api/src/dashboard/dashboard.rls.int.test.ts',
        title:
          'never counts another tenant findings, and refuses a caller with no role in the tenant',
      },
    ],
  },
  {
    id: '8.7',
    tests: [
      {
        file: 'packages/audit/src/redact.test.ts',
        title: 'redacts JWTs, Slack and Anthropic keys and PEM blocks',
      },
      {
        file: 'packages/contracts/src/entities/cost.test.ts',
        title: 'strips content fields instead of persisting them (§8.7)',
      },
    ],
  },
  {
    id: '8.8',
    tests: [
      {
        file: 'packages/db/src/audit.rls.int.test.ts',
        title: 'rejects a row that gaps, duplicates or forks the chain',
      },
      {
        file: 'packages/db/src/audit.rls.int.test.ts',
        title: 'denies UPDATE, DELETE and TRUNCATE to the app role',
      },
      {
        file: 'packages/audit/src/emit.test.ts',
        title: 'refuses a tampered outbox payload at relay time',
      },
      {
        file: 'packages/audit/src/chain.test.ts',
        title: 'hashes the JCS form with the head link, genesis first',
      },
      {
        file: 'packages/crypto/src/evidence-chain.test.ts',
        title: 'keeps fields apart: moving characters between neighbours changes the link',
      },
    ],
  },
  {
    id: '8.9',
    tests: [
      {
        file: 'apps/worker/src/agent-session/lifecycle.test.ts',
        title: 'records the pins, transcript key and usage on the finish row',
      },
      {
        file: 'packages/contracts/src/validation/replay-spec.test.ts',
        title: 'rejects pins with a malformed image digest',
      },
      {
        file: 'packages/contracts/src/validation/replay-spec.test.ts',
        title: 'rejects a replay spec with no pinned environment (§8.9: a missing pin fails)',
      },
      {
        file: 'packages/contracts/src/entities/cost.test.ts',
        title: 'refuses a missing price table pin',
      },
    ],
  },
  {
    id: '8.10',
    tests: [
      {
        file: 'apps/api/src/authorisations/service.test.ts',
        title:
          'refuses an SA that covers an unverified asset (AUTHZ_ASSET_UNVERIFIED) and stays a draft',
      },
      {
        file: 'apps/api/src/authorisations/service.test.ts',
        title: 'treats an asset of another tenant as unverified (fail closed)',
      },
      {
        file: 'apps/worker/src/verification/dns-txt/observe.test.ts',
        title: 'passes when the exact token is published at the derived name',
      },
    ],
  },
  {
    id: '8.11',
    tests: [
      {
        file: 'apps/agent-runtime/src/hooks/pre-tool-use.test.ts',
        title: 'never defers a destructive call: the PDP denies it and no exception is opened',
      },
      {
        file: 'packages/agents/src/prompt.test.ts',
        title: 'fails the lock check for a tampered body',
      },
      {
        file: 'apps/api/src/broker/pdp.test.ts',
        title: 'denies a state_changing call without a reversal-journal entry (§8.3)',
      },
    ],
  },
];

/** Evaluates the matrix against the invariant list. Pure: every file read goes through `reader`. */
export function evaluateInvariantMatrix(
  matrix: readonly MatrixEntry[],
  reader: FileReader,
  invariants: readonly { readonly id: string; readonly title: string }[] = SECURITY_INVARIANTS,
): MatrixReport {
  const known = new Set(invariants.map((inv) => inv.id));
  const unknown = [...new Set(matrix.map((e) => e.id).filter((id) => !known.has(id)))].sort();

  const broken: { id: string; ref: TestRef; status: RefStatus }[] = [];
  const results: InvariantResult[] = invariants.map((inv) => {
    const refs = matrix
      .filter((entry) => entry.id === inv.id)
      .flatMap((entry) => entry.tests)
      .map((ref): RefResult => {
        const content = reader.read(ref.file);
        const status: RefStatus =
          content === null ? 'missing_file' : content.includes(ref.title) ? 'ok' : 'missing_title';
        if (status !== 'ok') broken.push({ id: inv.id, ref, status });
        return { ref, status };
      });
    return { id: inv.id, title: inv.title, refs, status: refs.length > 0 ? 'covered' : 'gap' };
  });

  const gaps = results.filter((r) => r.status === 'gap').map((r) => r.id);
  return {
    green: gaps.length === 0 && broken.length === 0 && unknown.length === 0,
    invariants: results,
    gaps,
    broken,
    unknown,
  };
}

/** The CI artifact: invariant to backing tests, with each reference's resolution status. */
export function renderInvariantReport(report: MatrixReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
