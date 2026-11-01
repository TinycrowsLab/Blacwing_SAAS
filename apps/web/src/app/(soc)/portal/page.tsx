import { trace } from '@opentelemetry/api';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import * as React from 'react';

import { SOC_PORTAL_COOKIE } from '../../../lib/auth/cookies';
import { getSession, SessionUnavailableError, type Session } from '../../../lib/session';
import { resolvePortalAccess } from '../../../lib/soc-portal/access';
import { getSocPortalConfig } from '../../../lib/soc-portal/runtime';
import { openPortalSession } from '../../../lib/soc-portal/session';

import type { ReactNode } from 'react';

// Per-request: the portal answer depends on the visitor's cookies and must never be cached.
export const dynamic = 'force-dynamic';

const MS_PER_SECOND = 1000;
const SPAN_RENDER = 'soc.portal.render';

const getTracer = () => trace.getTracer('@blackwing/web');

/** Loads the console session; an outage of the session service is shown, not treated as "no session". */
async function loadSeat(): Promise<{ readonly session: Session | null; readonly outage: boolean }> {
  try {
    return { session: await getSession(), outage: false };
  } catch (err) {
    if (!(err instanceof SessionUnavailableError)) throw err;
    return { session: null, outage: true };
  }
}

/**
 * The SOC portal home. A `soc` seat or a verified link session may see it; anyone else is sent to the
 * expired page. The page is read-only: the emergency stop is added by SOCUI-004.
 */
export default function SocPortalPage(): Promise<ReactNode> {
  return getTracer().startActiveSpan(SPAN_RENDER, async (span) => {
    try {
      return await renderPortal();
    } finally {
      span.end();
    }
  });
}

async function renderPortal(): Promise<ReactNode> {
  const { session, outage } = await loadSeat();
  if (outage) {
    return (
      <section className="space-y-3" role="alert">
        <h1 className="text-xl font-semibold">The portal is temporarily unavailable</h1>
        <p>Reload this page in a minute.</p>
      </section>
    );
  }

  const config = getSocPortalConfig();
  const nowSeconds = Math.floor(Date.now() / MS_PER_SECOND);
  const jar = await cookies();
  const linkClaims =
    config === undefined
      ? null
      : openPortalSession(config.sessionKey, jar.get(SOC_PORTAL_COOKIE)?.value, nowSeconds);
  const access = resolvePortalAccess({ session, linkClaims });

  if (access.kind === 'none') redirect('/portal/expired');
  if (access.kind === 'seat') {
    return (
      <section className="space-y-3">
        <h1 className="text-xl font-semibold">SOC portal</h1>
        <p>
          Signed in as {access.userName} for {access.tenantSlug}. Read-only view.
        </p>
      </section>
    );
  }

  const { claims } = access;
  const count = claims.assetIds.length;
  const expiresAt = new Date(claims.exp * MS_PER_SECOND).toISOString();
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold">SOC portal</h1>
      <p>
        {count === 1 ? '1 system is' : `${String(count)} systems are`} in scope for this link.
        Read-only view.
      </p>
      <p>
        This link expires at <time dateTime={expiresAt}>{expiresAt}</time>.
      </p>
    </section>
  );
}
