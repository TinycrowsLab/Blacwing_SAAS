import { z } from 'zod';

/** Server-side origin of the control-plane API (never exposed to the browser). */
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:13400';
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_TOO_MANY = 429;
const TIMEOUT_MS = 10_000;
/** A kill link is ~450 characters; refuse anything absurd before it reaches the API. */
const TOKEN_MAX = 1024;
const TOKEN_SHAPE = /^[A-Za-z0-9_.-]+$/;

const previewSchema = z.object({ scope: z.enum(['asset', 'run']), label: z.string() });

export type KillLinkPreview =
  | { readonly kind: 'valid'; readonly scope: 'asset' | 'run'; readonly label: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'limited' };

export type KillLinkTrigger = 'done' | 'invalid' | 'limited';

export interface SocKillClientOptions {
  readonly fetch?: typeof fetch;
  readonly apiOrigin?: string | undefined;
}

export const isPlausibleToken = (token: string): boolean =>
  token.length > 0 && token.length <= TOKEN_MAX && TOKEN_SHAPE.test(token);

function origin(options: SocKillClientOptions): string {
  const value = options.apiOrigin ?? process.env.BW_API_ORIGIN;
  return (value === undefined || value === '' ? DEFAULT_API_ORIGIN : value).replace(/\/+$/, '');
}

/**
 * Forwards the visitor's address so the API's per-IP rate limit counts the SOC analyst, not this
 * server. Only the proxy chain's own `x-forwarded-for` is passed on.
 */
function headersFor(forwardedFor: string | null): Record<string, string> {
  return forwardedFor === null || forwardedFor === '' ? {} : { 'x-forwarded-for': forwardedFor };
}

/** Asks the API what the link would stop. Any failure other than 429 is "no longer valid". */
export async function previewKillLink(
  token: string,
  forwardedFor: string | null,
  options: SocKillClientOptions = {},
): Promise<KillLinkPreview> {
  if (!isPlausibleToken(token)) return { kind: 'invalid' };
  try {
    const res = await (options.fetch ?? fetch)(`${origin(options)}/soc/kill/${token}`, {
      headers: headersFor(forwardedFor),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === HTTP_TOO_MANY) return { kind: 'limited' };
    if (res.status !== HTTP_OK) return { kind: 'invalid' };
    const parsed = previewSchema.safeParse(await res.json());
    return parsed.success ? { kind: 'valid', ...parsed.data } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Fires the kill. Success is only an accepted (202) answer. */
export async function triggerKillLink(
  token: string,
  forwardedFor: string | null,
  options: SocKillClientOptions = {},
): Promise<KillLinkTrigger> {
  if (!isPlausibleToken(token)) return 'invalid';
  try {
    const res = await (options.fetch ?? fetch)(`${origin(options)}/soc/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headersFor(forwardedFor) },
      body: JSON.stringify({ token }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === HTTP_ACCEPTED) return 'done';
    return res.status === HTTP_TOO_MANY ? 'limited' : 'invalid';
  } catch {
    return 'invalid';
  }
}
