import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

const SIGN_IN = '/sign-in';

/**
 * Keeps signed-out visitors out of the application shell.
 *
 * This is a redirect, not an authorisation check. It reads only whether a
 * session cookie is present — it does not validate it, because doing so here
 * would mean a database round trip on every navigation, including static
 * assets. Anything that actually matters is decided by the API, which verifies
 * the session itself on every request. A forged cookie gets someone as far as
 * an empty page and no further.
 */
export default function proxy(request: NextRequest): NextResponse {
  const hasSession = getSessionCookie(request) !== null;

  if (hasSession) {
    return NextResponse.next();
  }

  const target = new URL(SIGN_IN, request.url);
  // Where they were headed, so signing in does not dump them on the home page
  // and make them navigate again. Only the path and query travel, so this
  // cannot be turned into an open redirect to another origin.
  target.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);

  return NextResponse.redirect(target);
}

export const config = {
  // Only the signed-in surface. The auth pages must stay reachable without a
  // session, or signing in would redirect to itself forever.
  matcher: ['/notes/:path*', '/settings/:path*'],
};
