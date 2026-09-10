import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/** Metadata key the origin check reads. */
export const SIGNED_REQUEST = 'core:signed-request';

/**
 * Marks a route that proves itself with a signature rather than a session.
 *
 * The origin check is CSRF protection, and CSRF is an attack on **ambient**
 * authority: a cross-site page can make a browser send a cookie it cannot
 * read. A route reached by a signed URL has no ambient authority to steal —
 * the signature is the whole of its authorization, it is not attached
 * automatically by anything, and a page that does not hold it cannot produce
 * it. Requiring an allowed `Origin` there refuses the legitimate callers (a
 * server with no `Origin` at all, a browser form posting from anywhere) while
 * stopping nothing.
 *
 * Use it only where that is true: the route must verify a signature itself and
 * must not read a session cookie.
 */
export function SignedRequest(): CustomDecorator<string> {
  return SetMetadata(SIGNED_REQUEST, true);
}
