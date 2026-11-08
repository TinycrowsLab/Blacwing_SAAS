// The visitor's address for the API's per-client limit on the no-login emergency page: the last hop of
// X-Forwarded-For, the one the nearest proxy (or the Next.js server) added; earlier hops are whatever the visitor sent.
// Server-only.
import { headers } from 'next/headers';

export async function clientIp(): Promise<string> {
  const h = await headers();
  const last = h.get('x-forwarded-for')?.split(',').at(-1)?.trim() ?? '';
  return last === '' ? (h.get('x-real-ip') ?? 'unknown') : last;
}
