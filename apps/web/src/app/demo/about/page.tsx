// DEMO-STORY: what is real and what is a demo stub. Read this before presenting.
import type { ReactNode } from 'react';

export const dynamic = 'force-static';

const ROWS: readonly [string, string, string][] = [
  ['Login and roles', 'Real', 'Keycloak OIDC (realm blackwing-dev), BFF session cookie, roles from the realm.'],
  ['Tenant, users, identities', 'Real', 'Seeded tenant acme and six users in blackwing_demo; the demo API resolves the signed-in user.'],
  ['Asset and ownership', 'Demo stub', 'Juice Shop on 127.0.0.1:3001 is registered as a demo asset. Ownership is "verified" by lab trust, not by a DNS or HTTP proof.'],
  ['Assessment request and scope', 'Real (demo tables)', 'Scope host and path are checked against the asset and the case. Stored in the demo schema, not the production assessment tables.'],
  ['Intrusiveness and budget', 'Real rules, demo enforcement', 'Destructive and state-changing classes are refused. The runner counts every request against the budget.'],
  ['Gate 1 (separation of duties)', 'Real rule, demo storage', 'The API refuses approval by the requester and needs the asset-owner role. Decisions are stored in the demo schema, not the audit ledger.'],
  ['Planner, specialist', 'Demo stub', 'Deterministic: they select the pinned case and name its oracle. No model call and no agent runtime.'],
  ['Sandbox, egress gateway, Temporal', 'Demo stub', 'No sandbox and no egress gateway. The demo runner talks to the lab target directly, inside the demo worker process.'],
  ['Probes against Juice Shop', 'Real', 'Real HTTP requests to the lab target: one benign probe, two replays and a negative control.'],
  ['Oracle and validation', 'Real logic, pinned case', 'Deterministic error-signature match (issue #881). Confirmed only when every replay matches and the control does not.'],
  ['Severity', 'Demo-assigned', 'The CVSS v4.0 vector and score are fixed for the story and are not computed.'],
  ['Report', 'Real rendering', 'HTML and Markdown rendered from the stored finding, evidence and pins.'],
  ['Kill switch, release gate (Gate 3), audit ledger', 'Not in the demo', 'Out of scope for this slice. See the console pages for those.'],
];

export default function DemoAboutPage(): ReactNode {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">What is real and what is a demo stub</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        This demo runs the story end to end on localhost. Everything marked stub is a stand-in for a production component
        that is still being built.
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left">
            <th className="border-b border-neutral-300 py-2 pr-4">Piece</th>
            <th className="border-b border-neutral-300 py-2 pr-4">State</th>
            <th className="border-b border-neutral-300 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([piece, state, notes]) => (
            <tr key={piece} className="align-top">
              <td className="border-b border-neutral-200 py-2 pr-4 dark:border-neutral-800">{piece}</td>
              <td className="border-b border-neutral-200 py-2 pr-4 dark:border-neutral-800">{state}</td>
              <td className="border-b border-neutral-200 py-2 dark:border-neutral-800">{notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
