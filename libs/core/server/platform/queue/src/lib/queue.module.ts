import { Global, Logger, Module, type DynamicModule } from '@nestjs/common';
import { BaseConfig, withDeadline } from '@workspace/core-server-core';
import { Redis } from 'ioredis';

import { QueueService } from './queue.service.js';
import { QUEUE_CONNECTION } from './queue.tokens.js';
import { assertNoEviction } from './redis-policy.js';

/**
 * How long the eviction check waits for an answer before giving up on the boot.
 *
 * It needs a deadline of its own. The connection below must set
 * `maxRetriesPerRequest: null`, and ioredis then queues a command against an
 * unreachable server forever rather than rejecting it — so a Redis that is
 * simply not there would leave the process hanging at startup with no log line
 * and no failure, which is worse than either starting or crashing.
 */
const EVICTION_CHECK_TIMEOUT_MS = 10_000;

/** Backoff between reconnection attempts, and the ceiling it climbs to. */
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 20_000;

function reconnectAfter(attempt: number): number {
  return Math.min(attempt * RECONNECT_BASE_MS, RECONNECT_MAX_MS);
}

/**
 * What the queue's connection has to be built with.
 *
 * `maxRetriesPerRequest: null` is not a preference. BullMQ blocks on
 * `BZPOPMIN` while it waits for work, and a client that gives up on a request
 * after a few retries would abandon that wait; the library refuses outright —
 * `new Worker(...)` throws — when it is handed an instance without it.
 *
 * `retryStrategy` is spelled out for a related reason: BullMQ supplies one of
 * its own only for connections it creates itself, so a connection handed to it
 * inherits ioredis's default instead, and the two behave differently under a
 * Redis that is restarting.
 */
const CONNECTION_OPTIONS = {
  maxRetriesPerRequest: null,
  retryStrategy: reconnectAfter,
} as const;

/**
 * Wires the queue to the Redis it must run on.
 *
 * Global because a queue is infrastructure: a feature module that wanted to
 * enqueue something would otherwise import this one, and the dependency graph
 * would say the feature depends on the queue library rather than on the
 * service it actually uses.
 *
 * `forRoot` rather than a plain module, because the connection is built when
 * the application is assembled — not when this file is imported. A decorator
 * argument is evaluated at import time, which would make importing anything
 * from this library fail in a process without a Redis.
 *
 * The eviction check lives in the factory rather than in a lifecycle hook.
 * Nest resolves a factory before it constructs anything that depends on it, so
 * there is no ordering to get right and no way to reach a `QueueService` whose
 * Redis was not checked. In `onModuleInit` it would still be possible for
 * another provider's `onModuleInit` to create a queue first.
 */
@Global()
@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    return {
      module: QueueModule,
      providers: [
        {
          provide: QUEUE_CONNECTION,
          inject: [BaseConfig],
          useFactory: async (config: BaseConfig): Promise<Redis> => {
            const redis = new Redis(
              config.get('REDIS_CRITICAL_URL'),
              CONNECTION_OPTIONS,
            );

            try {
              await withDeadline(
                assertNoEviction(redis),
                EVICTION_CHECK_TIMEOUT_MS,
                'The queue’s Redis',
              );
            } catch (failure) {
              // The client is closed on the way out, or a refused boot leaves
              // a socket reconnecting forever and the process never exits.
              redis.disconnect();
              throw failure;
            }

            new Logger(QueueModule.name).log(
              'The queue’s Redis will not evict; connected.',
            );

            return redis;
          },
        },
        QueueService,
      ],
      // The connection as well as the service, and only because this is the
      // instance the workspace guarantees will not evict — checked above, at
      // boot. The one other thing that needs that guarantee is the backup
      // timestamp behind `backup_age_seconds`: a key thrown away by a cache
      // would read as "no backup has ever run", which is the alarm that metric
      // exists to raise, raised for the wrong reason.
      //
      // The token was already in this library's public barrel; what was missing
      // was the module handing it to whoever imports it.
      exports: [QueueService, QUEUE_CONNECTION],
    };
  }
}
