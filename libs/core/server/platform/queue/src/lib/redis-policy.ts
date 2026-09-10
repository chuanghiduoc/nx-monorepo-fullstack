import type { Redis } from 'ioredis';

/**
 * The only eviction policy a queue can live with.
 *
 * Every other policy lets Redis drop a key under memory pressure, and the
 * queue's keys are the queue: a job, a lock, a scheduler. Losing one is not a
 * slow queue, it is work that silently never happened.
 */
const REQUIRED_POLICY = 'noeviction';

/** `CONFIG GET` answers with a flat [name, value] pair. */
const POLICY_VALUE_INDEX = 1;
const EXPECTED_REPLY_LENGTH = 2;

/**
 * What a Redis that has taken `CONFIG` away answers with.
 *
 * Managed services restrict the command in two different ways — removing it
 * outright, and revoking it from the ACL — and each has its own wording.
 * Anything else is a real failure and must not be read as consent.
 */
const COMMAND_UNAVAILABLE = /unknown command|NOPERM|not allowed|disabled/i;

export class EvictionPolicyError extends Error {
  constructor(actual: string) {
    super(
      `The queue's Redis has maxmemory-policy "${actual}". It must be "${REQUIRED_POLICY}": every other policy may drop a job, a lock or a scheduler under memory pressure, and nothing reports it.`,
    );
    this.name = 'EvictionPolicyError';
  }
}

/**
 * Refuses to start against a Redis that may evict.
 *
 * The queue library logs a warning about this and carries on — measured on
 * `allkeys-lru`: a line on stderr, then business as usual. A warning at
 * startup is read once, by whoever was watching; the guarantee has to be a
 * refusal or it is a comment.
 *
 * A connection that is not allowed to answer `CONFIG GET` is left alone:
 * managed Redis services routinely restrict the command, and refusing to start
 * there would be refusing to run in production to prove a point about
 * production. Only that one refusal is tolerated. A connection error, a
 * rejected password or a bug in this function are not evidence about the
 * policy, and swallowing them would turn this check into one that always
 * passes.
 */
export async function assertNoEviction(redis: Redis): Promise<void> {
  let reply: unknown;

  try {
    reply = await redis.config('GET', 'maxmemory-policy');
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);

    if (COMMAND_UNAVAILABLE.test(message)) {
      return;
    }

    throw failure;
  }

  if (!Array.isArray(reply) || reply.length < EXPECTED_REPLY_LENGTH) {
    throw new Error(
      `Redis answered CONFIG GET maxmemory-policy with ${JSON.stringify(reply)}, ` +
        'which is not a [name, value] pair. The eviction policy could not be established.',
    );
  }

  const policy = String(reply[POLICY_VALUE_INDEX]);

  if (policy !== REQUIRED_POLICY) {
    throw new EvictionPolicyError(policy);
  }
}
