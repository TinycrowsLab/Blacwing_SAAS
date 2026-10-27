import { getActivityContext } from '@blackwing/telemetry';

/** Test activity for `context.int.test.ts`: reports the context it runs under after `sleepMs`. */
export async function readContext(sleepMs: number): Promise<{ tenantId: string; traceId: string }> {
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
  const { tenantId, traceId } = getActivityContext();
  return { tenantId, traceId };
}
