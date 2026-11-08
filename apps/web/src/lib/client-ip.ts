// The visitor's address (first hop of X-Forwarded-For, which the Next.js server sets) for the API's per-client
// limit on the no-login emergency page. Server-only.
import { headers } from 'next/headers';

export async function clientIp(): Promise<string> {
  const h = await headers();
  const first = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return first === '' ? (h.get('x-real-ip') ?? 'unknown') : first;
}
