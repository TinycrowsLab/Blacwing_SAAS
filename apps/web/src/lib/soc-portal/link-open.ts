// The BFF side of opening a SOC portal link (SOCUI-001, #553). A GET on the link verifies the signed
// token, sets the scoped portal cookie, audits the open and redirects to the portal. The token is
// never echoed, logged or placed in the redirect target, and every refusal lands on the same generic
// expired page, whatever the reason.

import { metrics, trace, type Tracer } from '@opentelemetry/api';

import { sealPortalSession } from './session.js';
import { type SocPortalRejectReason, verifySocPortalLink } from './token.js';

import type { SocPortalConfig } from './config.js';
import type { JwsKeyResolver } from '@blackwing/crypto';
import type { Logger } from '@blackwing/logger';

const SOC_PORTAL_HOME = '/portal';
const SOC_PORTAL_EXPIRED = '/portal/expired';
const METER_NAME = '@blackwing/web';
const MS_PER_SECOND = 1000;
const SPAN_VERIFY = 'soc.link.verify';

/** The audit event for an accepted link, in the same shape the console audit events use. */
interface SocPortalOpenedAudit {
  readonly action: 'soc.portal.opened';
  readonly outcome: 'success';
  readonly tenantId: string;
  readonly linkId: string;
  readonly assetCount: number;
  readonly occurredAt: string;
}

export interface SocPortalLinkDeps {
  /** `undefined` when the portal is disabled: every link is then refused. */
  readonly config: SocPortalConfig | undefined;
  readonly now: () => number;
  readonly audit: (event: SocPortalOpenedAudit) => void;
  readonly logger: Logger;
  readonly tracer?: Tracer;
  readonly counters?: SocPortalLinkCounters;
}

export interface SocPortalLinkCounters {
  readonly opened: () => void;
  readonly rejected: (reason: SocPortalRejectReason | 'disabled') => void;
}

/** Link counters, bounded by reason; no token, tenant or asset value is ever a label. */
export function createSocPortalLinkCounters(): SocPortalLinkCounters {
  const meter = metrics.getMeter(METER_NAME);
  const opened = meter.createCounter('soc_link_opened_total', {
    description: 'SOC portal links accepted.',
  });
  const rejected = meter.createCounter('soc_link_rejected_total', {
    description: 'SOC portal links refused, by reason.',
  });
  return {
    opened: () => {
      opened.add(1);
    },
    rejected: (reason) => {
      rejected.add(1, { reason });
    },
  };
}

const NOT_ACCEPTED = (): Response => redirectTo(SOC_PORTAL_EXPIRED);

/** A `303 See Other` with no referrer leak and no cacheable answer; `cookie` is optional. */
function redirectTo(location: string, cookie?: string): Response {
  const headers = new Headers({
    location,
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  if (cookie !== undefined) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** Opens a link: the portal redirect with its session cookie, or the expired page. */
export function openSocPortalLink(token: string, deps: SocPortalLinkDeps): Response {
  const { config, logger } = deps;
  const tracer = deps.tracer ?? trace.getTracer(METER_NAME);
  if (config === undefined) {
    deps.counters?.rejected('disabled');
    logger.info({ reason: 'disabled' }, 'soc portal link refused');
    return NOT_ACCEPTED();
  }
  const resolveKey: JwsKeyResolver = (kid) => (kid === config.keyId ? config.publicKey : undefined);
  const nowSeconds = Math.floor(deps.now() / MS_PER_SECOND);

  const verdict = tracer.startActiveSpan(SPAN_VERIFY, (span) => {
    try {
      return verifySocPortalLink(token, resolveKey, nowSeconds);
    } finally {
      span.end();
    }
  });
  if (!verdict.ok) {
    deps.counters?.rejected(verdict.reason);
    logger.info({ reason: verdict.reason }, 'soc portal link refused');
    return NOT_ACCEPTED();
  }

  const { claims } = verdict;
  deps.counters?.opened();
  deps.audit({
    action: 'soc.portal.opened',
    outcome: 'success',
    tenantId: claims.tenantId,
    linkId: claims.jti,
    assetCount: claims.assetIds.length,
    occurredAt: new Date(deps.now()).toISOString(),
  });
  const cookie = sealPortalSession(config.sessionKey, claims, nowSeconds);
  return redirectTo(SOC_PORTAL_HOME, cookie);
}
