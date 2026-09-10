import { describe, expect, it } from 'vitest';

import { classifyFailure } from './retry-policy.js';

/**
 * The decision that separates a queue that recovers from one that spins.
 *
 * A pure function on purpose: this is the piece it must be possible to reason
 * about without a Redis, a job, or a worker — and the piece that is wrong most
 * often, because "retry everything" looks safe until the thing being retried
 * can never succeed.
 */
describe('classifying a failure', () => {
  it('retries a timeout', () => {
    const failure = Object.assign(new Error('socket hang up'), {
      code: 'ETIMEDOUT',
    });

    expect(classifyFailure(failure)).toBe('retryable');
  });

  it('retries the network errors that mean "not now"', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']) {
      const failure = Object.assign(new Error(code), { code });

      expect(classifyFailure(failure)).toBe('retryable');
    }
  });

  it('retries a server that said it was unavailable', () => {
    for (const status of [429, 502, 503, 504]) {
      expect(classifyFailure(Object.assign(new Error('busy'), { status }))).toBe(
        'retryable',
      );
    }
  });

  it('gives up on what the caller got wrong', () => {
    // A 400 does not become a 200 by asking again. Retrying it burns the
    // attempt budget and delays the dead-letter that a human has to look at.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyFailure(Object.assign(new Error('no'), { status }))).toBe(
        'fatal',
      );
    }
  });

  it('gives up on a payload it cannot parse', () => {
    // The defining case. A message whose shape is wrong is wrong on every
    // attempt, so retrying it is an infinite loop with a delay in it.
    expect(classifyFailure(new SchemaMismatch('version 3 is unknown'))).toBe(
      'fatal',
    );
  });

  it('treats anything it has never seen as unknown, not as fatal', () => {
    // Unknown retries to a ceiling and then dead-letters. Calling it fatal
    // would discard a transient failure nobody had classified yet; calling it
    // retryable would spin on a permanent one.
    expect(classifyFailure(new Error('something new'))).toBe('unknown');
    expect(classifyFailure('not even an error')).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
  });

  it('reads a status the way a fetch Response carries it', () => {
    // `error.status` and `error.response.status` are both common; a
    // classifier that knows only one silently returns unknown for the other.
    const nested = Object.assign(new Error('no'), { response: { status: 404 } });

    expect(classifyFailure(nested)).toBe('fatal');
  });

  it('leaves a hostname that does not resolve unclassified', () => {
    // ENOTFOUND is usually a hostname that is wrong in the configuration, and
    // calling that retryable spends every attempt of every job on a deploy
    // that will never work. It is not reliably permanent either, so `unknown`
    // is the honest answer: bounded retries, then a person.
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND api.exmaple.com'), {
      code: 'ENOTFOUND',
    });

    expect(classifyFailure(failure)).toBe('unknown');
  });
});

/** Stands in for whatever the envelope parser throws. */
class SchemaMismatch extends Error {
  readonly fatal = true;
}