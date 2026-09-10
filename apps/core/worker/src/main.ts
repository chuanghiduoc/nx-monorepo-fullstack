import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

import { reportBootFailure, stopOnSignal } from '@workspace/core-server-core';
import {
  TRACING,
  type Tracing,
} from '@workspace/core-server-observability';
import { QueueService } from '@workspace/core-server-queue';

import { OutboxRelay } from './app/outbox/outbox.relay.js';
import { WorkerModule } from './app/worker.module.js';

/**
 * The tracer, once the context has built it.
 *
 * Function scope would not do: `stopOnSignal` is registered against the
 * *promise* of a started context, because a signal arriving mid-boot has to be
 * handled, and its callback therefore runs outside this call.
 */
let tracing: Tracing | undefined;

async function bootstrap(): Promise<void> {
  const logger = new Logger('core-worker');

  // An application context, not an application: there is no HTTP server to
  // start, and `NestFactory.create` would build an adapter and a router that
  // nothing ever reaches.
  const starting = NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    // Without this Nest keeps its default `abortOnError: true`, which wraps
    // the dependency scan and every constructor in an `ExceptionsZone` whose
    // teardown is `process.exit(1)`. Measured: with the default, a bad
    // `WORKER_CONCURRENCY` or a missing `WORKER_DATABASE_URL` exited 1 having
    // printed Nest's own message — and the `catch` below, with the reason and
    // the flush, never ran at all. `false` makes the factory reject instead.
    abortOnError: false,
  });

  stopOnSignal(starting, {
    name: 'core-worker',
    beforeClose: async (app) => {
      // The relay stops first, because it is a producer: draining the queue
      // while it is still claiming would leave it filling a queue that had
      // just been emptied. It waits for the pass in flight, so no claim is
      // open when the database client disconnects.
      await app.get(OutboxRelay).stop();
      // Said before the wait, not after it: the drain has no deadline, so
      // between the signal and the next line a deploy watches a process that
      // has gone quiet for as long as its longest job takes. This is the line
      // that distinguishes that from one that has hung.
      logger.log('Claiming has stopped; letting the job in flight finish.');
      // Then every job in flight completes, and no new one is started — still
      // while the database is connected, which is why this cannot be a Nest
      // shutdown hook.
      await app.get(QueueService).drain();
    },
    // Flushes whatever the span processor is holding, after everything else
    // has closed. The spans from the last jobs a worker ran are the ones
    // somebody is looking for when they ask why a deploy lost work.
    afterClose: () => tracing?.shutdown(),
  });

  const app = await starting;
  app.useLogger(app.get(PinoLogger));
  tracing = app.get<Tracing>(TRACING);

  logger.log('core-worker is running.');
}

bootstrap().catch((error: unknown) => {
  reportBootFailure('core-worker', error);
});
