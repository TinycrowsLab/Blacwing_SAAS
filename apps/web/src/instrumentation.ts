/**
 * Next.js instrumentation hook (OBS-002, #299). The server side of the Node runtime starts telemetry; the edge
 * runtime is excluded by design, and client-side telemetry is out of scope for v1.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  await import('./instrument.js');
}
