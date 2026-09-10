import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOLERANCE_SECONDS,
  generateSecret,
  sign,
  verify,
} from './signature.js';

const SECRET = 'a-secret-that-is-long-enough-to-be-one';
const BODY = '{"eventId":"01a06400-0000-7000-8000-000000000001"}';
const AT = 1_788_000_000;

/**
 * What a receiver checks, and what stops a captured request being replayed.
 *
 * `verify` is exported and tested because a receiver that has to reimplement
 * it will get the timestamp half wrong — that is the half people skip — and
 * because a verification written twice is verified once.
 */
describe('signing a delivery', () => {
  it('produces a signature a receiver with the secret accepts', () => {
    const header = sign(BODY, SECRET, AT);

    expect(verify(BODY, header, SECRET, DEFAULT_TOLERANCE_SECONDS, AT)).toBe(
      true,
    );
  });

  it('carries the timestamp and the scheme version', () => {
    // Versioned because the day the scheme changes, both have to be sent for a
    // while and a receiver reading `v1=` has to keep working throughout.
    expect(sign(BODY, SECRET, AT)).toMatch(/^t=1788000000,v1=[0-9a-f]{64}$/);
  });

  it('refuses a body that was altered in flight', () => {
    const header = sign(BODY, SECRET, AT);

    expect(
      verify(`${BODY} `, header, SECRET, DEFAULT_TOLERANCE_SECONDS, AT),
    ).toBe(false);
  });

  it('refuses a signature made with a different secret', () => {
    const header = sign(BODY, 'somebody-elses-secret', AT);

    expect(verify(BODY, header, SECRET, DEFAULT_TOLERANCE_SECONDS, AT)).toBe(
      false,
    );
  });

  it('refuses a delivery older than the tolerance', () => {
    const header = sign(BODY, SECRET, AT);

    // The replay: the body and the signature are genuine, and they were
    // genuine an hour ago.
    expect(verify(BODY, header, SECRET, 300, AT + 3_600)).toBe(false);
  });

  it('refuses one from too far in the future', () => {
    const header = sign(BODY, SECRET, AT + 3_600);

    // Only checking the past would let a captured request be held until the
    // receiver's own clock caught up with its timestamp.
    expect(verify(BODY, header, SECRET, 300, AT)).toBe(false);
  });

  it('refuses a timestamp that was moved', () => {
    const header = sign(BODY, SECRET, AT);
    const moved = header.replace(`t=${AT}`, `t=${AT + 3_600}`);

    // The timestamp is inside the signed material, which is the whole reason
    // it is protection rather than decoration: moving it forward to get past
    // the tolerance breaks the digest.
    expect(verify(BODY, moved, SECRET, 300, AT + 3_600)).toBe(false);
  });

  it('refuses a header that is not one', () => {
    for (const header of [
      '',
      'nonsense',
      't=,v1=',
      `t=${AT}`,
      `v1=${'0'.repeat(64)}`,
      `t=not-a-number,v1=${'0'.repeat(64)}`,
    ]) {
      expect(
        verify(BODY, header, SECRET, DEFAULT_TOLERANCE_SECONDS, AT),
        `"${header}" should not verify`,
      ).toBe(false);
    }
  });

  it('refuses a digest of the wrong length rather than throwing', () => {
    // `timingSafeEqual` throws when the buffers differ in length, and an
    // exception here would reach a receiver as a 500 rather than a rejection.
    expect(verify(BODY, `t=${AT},v1=abcd`, SECRET, 300, AT)).toBe(false);
  });

  it('generates a secret with enough of it to matter', () => {
    const secret = generateSecret();

    // 32 bytes, base64url — no padding, nothing that needs escaping in a
    // header, an environment file or a JSON body.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(secret);
  });
});
