// About Blackwing: which parts run for real and which are still stand-ins.
import { Card, DataTable, PageHeader, Chip } from '../../../components/console/design';

import type { ReactNode } from 'react';

const ROWS: readonly [string, string, string][] = [
  [
    'Sign-in and roles',
    'Real',
    'Google sign-in. Only the administrators listed in BW_ADMIN_EMAILS get in, and each holds every role.',
  ],
  [
    'Asset ownership',
    'Real rule, attested',
    'An asset must be verified before a request. HTTP token proof is real. Owner attestation stands in for DNS or cloud proof.',
  ],
  [
    'Scope and method rules',
    'Real, enforced by the runner',
    'Every request is checked against the allowed origins and excluded paths. DELETE is refused. POST, PUT and PATCH need a Gate 2 decision.',
  ],
  [
    'Gate 1 and Gate 2',
    'Real rule, local storage',
    'The requester cannot approve. A Gate 2 request with no decision before its deadline is denied. Decisions are appended to a hash-chained audit ledger (see Audit ledger).',
  ],
  [
    'Agent team',
    'Real, direct model access',
    'A Claude agent team plans and probes. Model calls go direct, not through the model gateway. Agents have no shell or file tools. Their text is not verified.',
  ],
  [
    'Sandbox, egress gateway, Temporal',
    'Stub',
    'No sandbox and no egress gateway yet. The runner sends target requests from the worker process.',
  ],
  [
    'Validation',
    'Real',
    'A finding is confirmed only when the validator replays the probe three times with the oracle matching every time and the negative control not matching. The model never decides.',
  ],
  [
    'Kill switch',
    'Real, simplified',
    'Kill needs a typed confirmation and aborts the agent, denies pending Gate 2 requests and records the measured halt time. Only the run scope exists.',
  ],
  [
    'Report',
    'Real rendering',
    'Per finding: HTML and Markdown. Per run: HTML, Markdown, JSON and SARIF, released findings only.',
  ],
  [
    'Release gate (Gate 3)',
    'Real, simplified',
    'Validator-proven findings are released automatically. Suspected findings wait for an AppSec engineer to release or dismiss them with a reason. Only released findings reach reports and the webhook.',
  ],
  [
    'Audit ledger',
    'Real rule, local storage',
    'Gate 1, Gate 2, kill and Gate 3 decisions are appended to a SHA-256 hash chain. The audit page re-verifies the chain.',
  ],
  [
    'Delivery',
    'Real, optional',
    'With a webhook URL configured, each released finding is posted as Slack-compatible JSON and the result is shown on the finding.',
  ],
];

export default function AboutPage(): ReactNode {
  return (
    <div className="flex max-w-[820px] flex-col gap-3">
      <PageHeader
        crumbs={[{ label: 'About' }]}
        title="What is real and what is a stub"
      />
      <p className="max-w-3xl text-[13.5px] leading-6 text-muted-foreground">
        Blackwing runs the whole assessment flow end to end. Everything marked stub is a stand-in for
        a component that is still being built.
      </p>
      <Card as="div">
        <DataTable label="Real and stub parts" head={['Piece', 'State', 'Notes']}>
          {ROWS.map(([piece, state, notes]) => (
            <tr key={piece} className="align-top">
              <td className="px-4 py-3 font-medium">{piece}</td>
              <td className="px-4 py-3">
                <Chip tone={state.startsWith('Real') ? 'ok' : 'warn'} pill>
                  {state}
                </Chip>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{notes}</td>
            </tr>
          ))}
        </DataTable>
      </Card>
    </div>
  );
}
