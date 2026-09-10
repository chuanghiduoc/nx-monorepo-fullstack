import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The header a delivery is signed with. */
export const SIGNATURE_HEADER = 'x-webhook-signature';

/** The header carrying the event's id, for a receiver that deduplicates. */
export const EVENT_ID_HEADER = 'x-webhook-event-id';

/**
 * How far a delivery's timestamp may be from the receiver's clock.
 *
 * The value a receiver should use, published here because it is half of the
 * replay protection and a receiver that does not check it has none.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const SECRET_BYTES = 32;

/** A new endpoint's signing key. */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * Signs a delivery.
 *
 * `t=<unix seconds>,v1=<hex>` over `${t}.${body}`.
 *
 * **The timestamp is inside the signed material**, which is what makes it
 * replay protection rather than decoration: a captured request cannot have its
 * timestamp moved forward without invalidating the signature, so a receiver
 * that rejects an old timestamp rejects every replay.
 *
 * **Versioned**, because the day the scheme changes both have to be sent for a
 * while, and a receiver reading `v1=` must keep working throughout.
 */
export function sign(
  body: string,
  secret: string,
  atSeconds = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac('sha256', secret)
    .update(`${atSeconds}.${body}`)
    .digest('hex');

  return `t=${atSeconds},v1=${digest}`;
}

/**
 * Checks a signature the way a receiver should.
 *
 * Exported because a receiver in this workspace — a test, an example, the
 * eventual admin UI — must not have to reimplement it, and because a
 * verification written twice is verified once.
 */
export function verify(
  body: string,
  header: string,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts = new Map(
    header.split(',').map((part) => {
      const at = part.indexOf('=');
      return at === -1
        ? ([part.trim(), ''] as const)
        : ([part.slice(0, at).trim(), part.slice(at + 1).trim()] as const);
    }),
  );

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');

  if (!Number.isSafeInteger(timestamp) || provided === undefined) {
    return false;
  }

  // Both directions. A timestamp far in the future is as much a forgery as one
  // far in the past, and only checking the past lets a captured request be
  // held until its own clock skew makes it valid again.
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest();
  const candidate = Buffer.from(provided, 'hex');

  // `timingSafeEqual` throws on a length mismatch, which is itself an answer —
  // and a comparison that returned early on length would leak the digest's
  // size. The length check is constant with respect to the secret.
  if (candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidate, expected);
}
