import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE, SOC_PORTAL_COOKIE } from './lib/auth/cookies';

// A scoped SOC portal session opens only the SOC routes. It is a link credential, not a console session,
// so without a console session every other route answers 403 (the console would otherwise redirect to
// login, which a SOC visitor has no account for). Presence is checked here; the portal page verifies the
// sealed value itself, so a forged cookie can only earn this 403, never a console view.
const SOC_PREFIXES = ['/portal', '/link', '/soc', '/_next', '/favicon.ico'];

const isSocPath = (pathname: string): boolean =>
  SOC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export function middleware(request: NextRequest): NextResponse {
  const { cookies, nextUrl } = request;
  if (!cookies.has(SOC_PORTAL_COOKIE) || cookies.has(SESSION_COOKIE)) return NextResponse.next();
  if (isSocPath(nextUrl.pathname)) return NextResponse.next();
  return new NextResponse('Forbidden', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
