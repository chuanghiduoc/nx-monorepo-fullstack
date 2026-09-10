/**
 * Gives a promise a deadline.
 *
 * Needed more often than it looks. A client that retries forever rather than
 * failing — ioredis with `maxRetriesPerRequest: null`, which BullMQ requires —
 * never rejects when the server is unreachable: it queues the command and
 * waits. Anything awaiting it therefore has no failure to catch, no error to
 * log and no way to move on, so a process ends up stopped at a line that looks
 * like it is working.
 *
 * The timer is cleared on every path. A pending one keeps the event loop alive,
 * so a process that has already decided to exit would otherwise sit there until
 * it fired.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  describe: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DeadlineError(describe, ms)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raised when work outlives its deadline.
 *
 * A distinct type because a caller usually wants to treat it differently from
 * the failure it was waiting on: nothing is known to have gone wrong, only
 * that nothing is known at all.
 */
export class DeadlineError extends Error {
  constructor(describe: string, ms: number) {
    super(`${describe} did not answer within ${ms}ms.`);
    this.name = 'DeadlineError';
  }
}
