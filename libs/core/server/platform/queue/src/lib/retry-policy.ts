/**
 * What to do about a failure.
 *
 * Three answers, because two is not enough. "Retry" and "give up" leaves
 * nowhere to put a failure nobody has classified yet, and whichever of the two
 * it gets lumped into is wrong half the time: called retryable, a permanent
 * failure spins; called fatal, a transient one is discarded.
 */
export type FailureClass = 'retryable' | 'fatal' | 'unknown';

/** Transport failures that mean "not now" rather than "not ever". */
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// `ENOTFOUND` is deliberately absent. It is NXDOMAIN, and the usual cause is a
// hostname that is wrong in the configuration — permanent, and calling it
// retryable spends every attempt of every job on a deploy that will never
// work. It is not reliably fatal either: some resolvers report a nameserver
// outage the same way. So it falls through to `unknown`, which is what that
// class exists for — bounded retries, then a person.


/** Answers that will be the same next time, so asking again is a waste. */
const FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 422]);

/** Answers that are explicitly "come back later". */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function statusOf(failure: unknown): number | undefined {
  if (typeof failure !== 'object' || failure === null) {
    return undefined;
  }

  const { status, response } = failure as {
    status?: unknown;
    response?: { status?: unknown };
  };

  // Both shapes are common in the wild — a thrown error carrying the status,
  // and one carrying the response it came from. A classifier that reads only
  // one returns `unknown` for half the failures it was written for.
  if (typeof status === 'number') {
    return status;
  }

  return typeof response?.status === 'number' ? response.status : undefined;
}

function codeOf(failure: unknown): string | undefined {
  if (typeof failure !== 'object' || failure === null) {
    return undefined;
  }

  const { code } = failure as { code?: unknown };

  return typeof code === 'string' ? code : undefined;
}

/**
 * Classifies a failure without knowing what produced it.
 *
 * Anything carrying `fatal: true` says so about itself — that is how the
 * envelope parser reports a message it cannot read, which is the case that
 * must never be retried: its shape will not change between attempts.
 *
 * `retryable: true` is the other half, and it exists because without it a
 * handler had no way to say "try again". Nothing this classifier reads on its
 * own — socket errno codes, HTTP statuses — is produced by a database driver:
 * measured, every failure from Prisma arrives as `P2010` or `P2028` with no
 * status, so every one of them fell to `unknown` and was given five attempts
 * before being buried. The layer that knows what a SQLSTATE means is the one
 * that says so.
 */
export function classifyFailure(failure: unknown): FailureClass {
  if (
    typeof failure === 'object' &&
    failure !== null &&
    (failure as { fatal?: unknown }).fatal === true
  ) {
    return 'fatal';
  }

  // After `fatal`, deliberately. An error carrying both is fatal: `fatal` is a
  // claim about the shape of the message, and no amount of retrying changes a
  // shape. The natural place to add a branch is the top of a function, which
  // is why the order is pinned by a test rather than by this comment.
  if (
    typeof failure === 'object' &&
    failure !== null &&
    (failure as { retryable?: unknown }).retryable === true
  ) {
    return 'retryable';
  }

  const code = codeOf(failure);
  if (code !== undefined && RETRYABLE_CODES.has(code)) {
    return 'retryable';
  }

  const status = statusOf(failure);
  if (status !== undefined) {
    if (RETRYABLE_STATUSES.has(status)) {
      return 'retryable';
    }
    if (FATAL_STATUSES.has(status)) {
      return 'fatal';
    }
  }

  return 'unknown';
}
