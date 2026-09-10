import { Logger, type INestApplicationContext } from '@nestjs/common';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Waits for what has already been written to stdout to reach the other end.
 *
 * `process.exit` does not flush it. In a container stdout is a pipe, so pino's
 * writes are asynchronous, and exiting immediately after logging drops the last
 * lines — measured on Linux: of 200 001 lines written before an exit, 384
 * arrived, and the final one was not among them. The lines at risk are exactly
 * the ones worth having: that the process stopped, or the reason it did not.
 *
 * Writing an empty chunk and waiting for its callback works because a stream
 * delivers callbacks in order, so this one fires once everything queued before
 * it has gone.
 */
export function flushOutput(): Promise<void> {
  // **Both streams.** Nest's `ConsoleLogger` writes `error` and `fatal` to
  // stderr and everything else to stdout, so a boot failure's reason and stack
  // are on the stream this used to ignore — exactly the lines worth having,
  // waited for on the wrong pipe.
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(
    () => undefined,
  );
}

function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => {
      resolve();
    });
  });
}

function reasonFor(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Reports a boot failure and stops, so that a container that will not start
 * says why.
 *
 * Three things have to happen and each was got wrong once:
 *
 * - **The message, separately from the stack.** Nest's `Logger` treats a second
 *   argument as a stack trace, so passing the error object alone prints a
 *   failure with no reason — and the reason is the only useful part.
 * - **`Logger.flush()`.** Both processes boot with `bufferLogs: true`, which
 *   holds every line until `useLogger` runs, and a boot that failed never gets
 *   there. Measured: the process printed nothing at all and looked like it was
 *   hanging.
 * - **`abortOnError: false` at the factory**, which is not here but is what
 *   makes this reachable: Nest's default runs the dependency scan inside an
 *   `ExceptionsZone` that calls `process.exit(1)` itself, so a provider
 *   throwing in its constructor never reaches a `catch` at all.
 * - **`flushOutput()` before exiting**, because `process.exit` does not flush a
 *   pipe.
 *
 * The message is normalised because Prisma's begins with a blank line: taken
 * verbatim it produced `core-worker failed to start:` and nothing else, so the
 * one line somebody greps for was the one line with no content in it.
 */
export function reportBootFailure(name: string, failure: unknown): void {
  Logger.error(`${name} failed to start: ${firstLineOf(reasonFor(failure))}`);

  if (failure instanceof Error && failure.stack) {
    Logger.error(failure.stack);
  }

  Logger.flush();

  process.exitCode = 1;
  void flushOutput().then(() => {
    process.exit(1);
  });
}

/** How much of a multi-line reason fits on one line worth reading. */
const MAX_REASON = 400;

/**
 * A multi-line message folded onto one, which is what a log line is.
 *
 * Keeping only the first line was not enough: the environment schema puts its
 * heading on line one and the variable names on the lines after it, so a
 * failure grepped as `Invalid environment configuration:` without saying which
 * variable. The stack printed after it keeps the original layout.
 */
function firstLineOf(message: string): string {
  const folded = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('; ');

  if (folded.length === 0) {
    return 'no reason given';
  }

  return folded.length > MAX_REASON ? `${folded.slice(0, MAX_REASON)}…` : folded;
}

/**
 * Closes a Redis client on the way out, quietly when there is nothing to say.
 *
 * `quit` is the polite close: commands already in flight finish and the server
 * is told, rather than watching a socket vanish. Two things make it throw and
 * neither is a problem worth a line:
 *
 * - the client already ended, which ioredis does itself when the socket
 *   closes — its `status` says so;
 * - `Connection is closed`, which it throws when the socket went between the
 *   status check and the call. Measured on every production shutdown, which is
 *   how a warning stops being read.
 *
 * Anything else is reported, because a close that fails for a reason nobody
 * has seen is worth knowing about.
 */
export async function closeRedis(
  client: { status: string; quit: () => Promise<unknown> },
  describe: string,
  logger: { warn: (message: string) => void },
): Promise<void> {
  if (client.status === 'end' || client.status === 'close') {
    return;
  }

  try {
    await client.quit();
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);

    if (/connection is closed|connection is already closed/i.test(reason)) {
      return;
    }

    logger.warn(`${describe} did not close cleanly: ${reason}`);
  }
}

export interface StopOnSignalOptions {
  /** Names the process in the log lines a person reads during a deploy. */
  readonly name: string;
  /**
   * Work that must happen while the application is still fully connected.
   *
   * Nest runs every `onModuleDestroy` — where the database client
   * disconnects — before any `onApplicationShutdown`, so anything that needs a
   * live connection cannot be a shutdown hook. It goes here instead, and runs
   * before `app.close()`.
   */
  readonly beforeClose?: (
    app: INestApplicationContext,
  ) => Promise<void> | void;
  /**
   * Work that must happen after everything else has closed.
   *
   * For the things that have to see the shutdown itself: a span exporter
   * holding a batch, a metric that is only worth pushing once. Anything here
   * runs with the application already gone, so it must not need it.
   */
  readonly afterClose?: () => Promise<void> | void;
}

/**
 * Stops an application on a signal, in an order Nest's own hooks cannot express.
 *
 * `enableShutdownHooks` is deliberately not used. It re-raises the signal after
 * the hooks run, so the process dies *by signal* — exit 143 — and whatever the
 * logger had queued is dropped. `useProcessExit: true` changes the code and not
 * the flush, because `process.exit` does not drain an asynchronous stdout
 * either. Owning the signal is what allows both: close, flush, then exit.
 *
 * Shared by both applications so they behave the same. They differ only in what
 * has to happen before the close, which is what `beforeClose` is for.
 */
export function stopOnSignal(
  starting: Promise<INestApplicationContext>,
  options: StopOnSignalOptions,
): void {
  const logger = new Logger(options.name);
  let stopping = false;

  const stop = (signal: string): void => {
    if (stopping) {
      // A second signal is somebody being impatient, not new information.
      // Acting on it would abandon whatever the first one is waiting for.
      logger.log(`${signal}: already stopping.`);
      return;
    }
    stopping = true;

    void (async () => {
      // If the context is still being built, wait for it: closing half of one
      // is worse than waiting for the whole.
      const app = await starting.catch(() => undefined);

      if (!app) {
        logger.log(`${signal}: stopping before startup finished.`);
        await flushOutput();
        process.exit(process.exitCode ?? 0);
      }

      logger.log(`${signal}: stopping.`);

      try {
        await options.beforeClose?.(app);
      } catch (failure) {
        // Reported, not rethrown: whatever could not finish leaves *more* to
        // close, not less, and the teardown below has to happen either way.
        logger.error(`Did not finish cleanly: ${reasonFor(failure)}`);
        process.exitCode = 1;
      } finally {
        try {
          await app.close();
        } catch (failure) {
          logger.error(`Did not stop cleanly: ${reasonFor(failure)}`);
          process.exitCode = 1;
        }
      }

      try {
        await options.afterClose?.();
      } catch (failure) {
        // The same rule as above: reported, and the exit happens either way.
        logger.error(`Did not flush cleanly: ${reasonFor(failure)}`);
        process.exitCode = 1;
      }

      if (!process.exitCode) {
        logger.log('Stopped.');
      }

      await flushOutput();
      process.exit(process.exitCode ?? 0);
    })();
  };

  // Registered before the context has finished being built: startup can take
  // seconds — a connection check, a migration wait — and a signal arriving in
  // that window would otherwise meet the default disposition and kill the
  // process with nothing in the log to say what happened.
  //
  // `on`, not `once`. `once` removes the listener as it fires and Node then
  // restores the default disposition, so a second Ctrl+C terminates the process
  // mid-transaction. Measured: with `once` the work in flight never finished;
  // with `on` it did. The flag above is what makes the second signal harmless.
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      stop(signal);
    });
  }
}
