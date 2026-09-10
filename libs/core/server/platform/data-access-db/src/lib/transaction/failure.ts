/**
 * Says whether a database failure is worth trying again.
 *
 * The queue classifies a handler's failure into retry, give up, or nobody
 * knows — and it reads three things to decide: a self-declared `fatal`, a
 * socket errno, or an HTTP status. A database driver produces none of them.
 * Measured with Prisma 7.10 and `@prisma/adapter-pg`: a unique violation, a
 * missing column, a backend terminated by an administrator and a permission
 * denial **all** arrive as `PrismaClientKnownRequestError` with
 * `code: 'P2010'`, and pool exhaustion and a transaction timeout both as
 * `P2028`. So every database failure fell to "nobody knows", which is five
 * attempts and then a dead letter — and a thirty-second restart therefore
 * buried every job in flight, permanently, because the outbox row was already
 * marked delivered.
 *
 * `error.code` cannot separate them. The value that can is the SQLSTATE the
 * driver kept underneath it.
 */

/**
 * Where `@prisma/adapter-pg` records the code PostgreSQL actually returned.
 *
 * **Two places, not one.** A failure raised by a *statement* is a
 * `PrismaClientKnownRequestError` and keeps the SQLSTATE under
 * `meta.driverAdapterError.cause.originalCode`. A failure raised by the
 * *transaction machinery* — at `COMMIT`, most importantly — is a
 * `DriverAdapterError` with no `code` and no `meta` at all, and keeps it under
 * `cause.originalCode`. Measured: a real SERIALIZABLE write conflict arrives as
 * `code: undefined, meta: undefined, cause: { originalCode: '40001' }`, so a
 * reader that knew only the first place never matched the single most important
 * entry in the retryable set.
 */
interface PrismaDriverFailure {
  code?: unknown;
  message?: unknown;
  meta?: {
    driverAdapterError?: {
      cause?: { originalCode?: unknown };
    };
  };
  cause?: { originalCode?: unknown };
}

/**
 * The database is there and will be back: it is restarting, going away, out of
 * connections, or refusing to referee two transactions.
 *
 * `57P03` is the one that matters most in practice — "the database system is
 * starting up" is what a restart answers with once the port is listening
 * again, and it is the whole window a rolling database upgrade opens.
 */
const RETRYABLE_SQLSTATE = new Set([
  '08000', // connection exception
  '08003', // connection does not exist
  '08006', // connection failure
  '40001', // serialization failure
  '40P01', // deadlock detected
  '53300', // too many connections
  '55P03', // lock not available
  '57014', // statement cancelled — a statement_timeout under load
  '57P01', // admin shutdown
  '57P03', // cannot connect now — starting up
]);

/**
 * A connection that died with no SQLSTATE to show for it.
 *
 * Measured on Prisma 7.10: when the socket dies while the client is *idle*
 * between two statements, or at `COMMIT`, there is no `ErrorResponse` to carry
 * a code — the driver throws a bare `Error` whose `name` is `Error`, whose
 * `code` is `undefined`, and which has no `meta`. Nothing above matches it, so
 * it classified as "nobody knows": five attempts over about fifteen seconds
 * and then a permanent dead letter.
 *
 * That is the exact window a rolling database restart opens, and it is the one
 * this whole file exists to close. The audit consumer's outbox row is already
 * `ENQUEUED` by then — `claimPending` looks only at `PENDING`, `reclaimStale`
 * only at `PROCESSING` — so the event is gone from the trail for good.
 *
 * Matching on a message is a last resort and is treated as one: it is the only
 * signal the driver gives, the strings are Prisma's own, and each is anchored
 * to a phrase that names the connection rather than to a whole sentence.
 */
const LOST_CONNECTION_PHRASES = [
  'connection error and is not queryable',
  'connection closed',
  'connection is closed',
  'connection terminated',
  'server has closed the connection',
  'socket hang up',
];

/** Prisma's own codes for a client that ran out of room rather than a server. */
const RETRYABLE_PRISMA_CODES = new Set([
  'P2024', // timed out fetching a connection from the pool
  'P2028', // transaction API error, which is what pool exhaustion looks like
]);

/**
 * Asking again will get the same answer: the statement is wrong, or this role
 * may not run it. `23xxx` is every constraint violation; `42xxx` is every
 * syntax and undefined-object error, of which `42501` — insufficient
 * privilege — is the one a grant change produces.
 */
function isPermanent(sqlState: string): boolean {
  return sqlState.startsWith('23') || sqlState.startsWith('42');
}

function sqlStateOf(failure: PrismaDriverFailure): string | undefined {
  const fromStatement = failure.meta?.driverAdapterError?.cause?.originalCode;

  if (typeof fromStatement === 'string') {
    return fromStatement;
  }

  // The transaction machinery's shape: no `code`, no `meta`, the SQLSTATE one
  // level down. This is where a COMMIT-time `40001` lives.
  const fromTransaction = failure.cause?.originalCode;

  return typeof fromTransaction === 'string' ? fromTransaction : undefined;
}

/** Whether a failure with no code at all is a connection that went away. */
function lostConnection(failure: PrismaDriverFailure): boolean {
  const message = typeof failure.message === 'string' ? failure.message : '';
  const lowered = message.toLowerCase();

  return LOST_CONNECTION_PHRASES.some((phrase) => lowered.includes(phrase));
}

/**
 * Marks a database failure so the queue can classify it.
 *
 * **Mutates rather than wraps.** A wrapper replaces the stack with one that
 * points here, and the stack is the only part of a dead-lettered job worth
 * opening — the queue library makes the same choice for the same reason.
 *
 * Anything that is not a Prisma error passes through untouched, so a
 * `NotFoundException` a repository raises is not relabelled as a transport
 * problem. Anything the sets above do not name is left alone too: it then
 * classifies as "nobody knows", which is honest and bounded.
 */
export function annotateDatabaseFailure(failure: unknown): unknown {
  if (typeof failure !== 'object' || failure === null) {
    return failure;
  }

  const candidate = failure as PrismaDriverFailure & {
    retryable?: boolean;
    fatal?: boolean;
  };
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;

  if (code?.startsWith('P') && RETRYABLE_PRISMA_CODES.has(code)) {
    candidate.retryable = true;
    return failure;
  }

  // The SQLSTATE is looked for **before** deciding this is not a Prisma error,
  // because the shape that carries it at COMMIT has no `code` to check.
  const sqlState = sqlStateOf(candidate);

  if (!sqlState) {
    // No code and no SQLSTATE. A dead connection looks exactly like this, and
    // it is the one case worth reading a message for — everything else falls
    // through untouched, which classifies as "nobody knows": bounded, honest,
    // and what a genuinely unknown failure deserves.
    if (lostConnection(candidate)) {
      candidate.retryable = true;
    }

    return failure;
  }

  if (RETRYABLE_SQLSTATE.has(sqlState)) {
    candidate.retryable = true;
  } else if (isPermanent(sqlState)) {
    candidate.fatal = true;
  }

  return failure;
}
