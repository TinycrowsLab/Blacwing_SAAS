// Emergency stop (design 3b): opened from a link an administrator shared, with no login. Always dark, full screen. A
// live link shows the workspace, how many audits run and the link's validity, and one hold-to-stop button. An expired,
// revoked or unknown link reads the same ("This emergency link has expired or been revoked") and shows only the workspace's own
// emergency contact, when an administrator set one.
import { EmergencyFrame, EmergencyNotice, EmergencyStop } from '../../../components/console/emergency';
import { ApiError, callEmergencyApi } from '../../../lib/api';
import { clientIp } from '../../../lib/client-ip';
import { emergencyViewSchema, type EmergencyView } from '../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
// The token is in the URL: never send it on as a referrer, never index the page.
export const metadata: Metadata = {
  title: 'Emergency stop',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

const HTTP_TOO_MANY = 429;

type Loaded = EmergencyView | { readonly status: 'busy' } | { readonly status: 'unreachable' };

async function load(token: string): Promise<Loaded> {
  try {
    return emergencyViewSchema.parse(await callEmergencyApi('/view', { token }, await clientIp()));
  } catch (error) {
    return error instanceof ApiError && error.status === HTTP_TOO_MANY ? { status: 'busy' } : { status: 'unreachable' };
  }
}

export default async function EmergencyPage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}): Promise<ReactNode> {
  const { token } = await params;
  const view = await load(token);
  if (view.status === 'active')
    return (
      <EmergencyStop
        token={token}
        workspace={view.workspace}
        liveRuns={view.liveRuns}
        label={view.link.label}
        expiresAt={view.link.expiresAt}
      />
    );
  return (
    <EmergencyFrame badge>
      {view.status === 'expired' ? (
        <EmergencyNotice
          eyebrow="Link expired or revoked"
          title="This emergency link has expired or been revoked"
          contact={view.contact}
        >
          {view.contact === null
            ? 'If testing is still affecting your systems, ask your Blackwing administrator for a new link or to stop it from the console.'
            : 'If testing is still affecting your systems, call now.'}
        </EmergencyNotice>
      ) : view.status === 'busy' ? (
        <EmergencyNotice eyebrow="Too many attempts" title="Wait a minute, then open the link again" contact={null}>
          This link was tried too many times from your network.
        </EmergencyNotice>
      ) : (
        <EmergencyNotice eyebrow="Can’t reach Blackwing" title="This page could not load" contact={null} retry>
          Nothing was stopped. Try again in a moment.
        </EmergencyNotice>
      )}
    </EmergencyFrame>
  );
}
