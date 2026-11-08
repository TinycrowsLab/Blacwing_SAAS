// Optional delivery of a released finding to a Slack-compatible webhook. No webhook configured means nothing happens.
import { scrubDeep } from '@blackwing/errors/scrub';

import type { HuntContext } from './context.js';

const WEBHOOK_TIMEOUT_MS = 5000;

export interface ReleasedFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly cwe: string;
  readonly owasp: string;
  readonly reproCurl: string;
}

/** POSTs the finding and records the result on it. A failed delivery never fails the run, and the URL is never stored or logged. */
export async function deliverRelease(ctx: HuntContext, finding: ReleasedFinding): Promise<void> {
  const url = ctx.deps.webhookUrl;
  if (url === null) return;
  const link = `${ctx.deps.consoleOrigin}/findings/${finding.id}`;
  const severity = finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1);
  const body = {
    text: `Blackwing released a ${severity} finding on ${ctx.run.assetName}: ${finding.title}. ${link}`,
    finding: { ...finding, asset: ctx.run.assetName, url: link, releasedBy: 'automatic' },
  };
  let status: 'delivered' | 'failed';
  let detail: string;
  try {
    const response = await ctx.deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Leaves Blackwing: scrubbed again even though the stored fields already are.
      body: JSON.stringify(scrubDeep(body)),
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    status = response.ok ? 'delivered' : 'failed';
    detail = `HTTP ${response.status}`;
  } catch (error) {
    status = 'failed';
    detail = error instanceof Error ? error.name : 'unknown';
  }
  await ctx.store.recordDelivery(finding.id, status, detail);
}
