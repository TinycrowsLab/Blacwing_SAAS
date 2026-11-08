'use server';

// The no-login emergency page's two calls: stop every live audit, then read their halt. The link's token is the only
// credential; the API checks it (hash, constant-time compare, expiry, revocation, rate limit) and writes the ledger.
import { z } from 'zod';

import { callEmergencyApi, toResult, type ActionResult } from '../../../lib/api';
import { clientIp } from '../../../lib/client-ip';
import { auditRefSchema, emergencyRunSchema, type EmergencyRun } from '../../../lib/schemas';

const stopSchema = z.object({ stoppedAt: z.string(), runs: z.array(emergencyRunSchema), audit: auditRefSchema });
const runsSchema = z.object({ runs: z.array(emergencyRunSchema) });

export async function stopAllAction(
  token: string,
): Promise<ActionResult<{ stoppedAt: string; runs: EmergencyRun[]; hash: string | null }>> {
  const ip = await clientIp();
  return toResult(async () => {
    const r = stopSchema.parse(await callEmergencyApi('/stop', { token }, ip));
    return { stoppedAt: r.stoppedAt, runs: r.runs, hash: r.audit?.hash ?? null };
  });
}

export async function haltAction(token: string, runIds: readonly string[]): Promise<ActionResult<EmergencyRun[]>> {
  const ip = await clientIp();
  return toResult(async () => runsSchema.parse(await callEmergencyApi('/runs', { token, runIds }, ip)).runs);
}
