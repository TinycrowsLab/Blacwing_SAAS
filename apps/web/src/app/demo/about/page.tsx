// What is real and what is a demo stub. Read this before presenting.
import { Card, DataTable, PageHeader, Chip } from '../../../components/demo/design';

import type { ReactNode } from 'react';

export const dynamic = 'force-static';

const ROWS: readonly [string, string, string][] = [
  ['Login and roles', 'Real', 'Keycloak OIDC, BFF session cookie, roles from the realm.'],
  [
    'Asset ownership',
    'Real rule, demo attestation',
    'An asset must be verified before a request. HTTP token proof is real. Owner attestation stands in for DNS or cloud proof.',
  ],
  [
    'Scope and method rules',
    'Real, enforced by the runner',
    'Every request is checked against the allowed origins and excluded paths. DELETE is refused. POST, PUT and PATCH need a Gate 2 decision.',
  ],
  [
    'Gate 1 and Gate 2',
    'Real rule, demo storage',
    'The requester cannot approve. A Gate 2 request with no decision before its deadline is denied. Decisions are stored in the demo schema, not the audit ledger.',
  ],
  [
    'Agent team',
    'Real, direct model access',
    'A Claude agent team plans and probes. Model calls go direct, not through the model gateway. Agents have no shell or file tools. Their text is not verified.',
  ],
  [
    'Sandbox, egress gateway, Temporal',
    'Demo stub',
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
    'HTML and Markdown rendered from the stored finding, evidence and pins.',
  ],
  ['Release gate (Gate 3), audit ledger', 'Not in the demo', 'Out of scope for this slice.'],
];

export default function DemoAboutPage(): ReactNode {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'About the demo' }]}
        title="What is real and what is a demo stub"
      />
      <p className="max-w-3xl text-[13.5px] leading-6 text-muted-foreground">
        This demo runs the story end to end on localhost. Everything marked stub is a stand-in for a
        production component that is still being built.
      </p>
      <Card as="div">
        <DataTable label="Real and stub parts" head={['Piece', 'State', 'Notes']}>
          {ROWS.map(([piece, state, notes]) => (
            <tr key={piece} className="align-top">
              <td className="px-4 py-3 font-medium">{piece}</td>
              <td className="px-4 py-3">
                <Chip
                  tone={
                    state.startsWith('Real') ? 'ok' : state === 'Not in the demo' ? 'muted' : 'warn'
                  }
                  pill
                >
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
