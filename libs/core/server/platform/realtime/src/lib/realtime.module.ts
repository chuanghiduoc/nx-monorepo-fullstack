import { Global, Logger, Module, type DynamicModule } from '@nestjs/common';
import { BaseConfig } from '@workspace/core-server-core';
import { Redis } from 'ioredis';

import { RealtimeBus } from './realtime.bus.js';
import { REALTIME_CHANNEL, REALTIME_REDIS } from './realtime.tokens.js';

/** Backoff between reconnection attempts, and the ceiling it climbs to. */
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 20_000;

function reconnectAfter(attempt: number): number {
  return Math.min(attempt * RECONNECT_BASE_MS, RECONNECT_MAX_MS);
}

/**
 * Wires the realtime bus to the Redis it fans out on.
 *
 * Global for the same reason the queue is: publishing is infrastructure, and a
 * feature module that imported this one would make the dependency graph say the
 * feature depends on the realtime library rather than on the one service it
 * uses.
 *
 * `forRoot` rather than a plain module, because the connection is built when
 * the application is assembled and not when this file is imported — a decorator
 * argument is evaluated at import time, which would make importing anything
 * from here fail in a process with no Redis.
 *
 * **No eviction check, unlike the queue.** Pub/Sub stores nothing, so there is
 * nothing for an eviction policy to throw away; that is exactly why this may
 * share the queue's instance without inheriting its requirement.
 */
@Global()
@Module({})
export class RealtimeModule {
  static forRoot(): DynamicModule {
    return {
      module: RealtimeModule,
      providers: [
        {
          provide: REALTIME_REDIS,
          inject: [BaseConfig],
          useFactory: (config: BaseConfig): Redis => {
            const url =
              config.get('REALTIME_REDIS_URL') ?? config.get('REDIS_CRITICAL_URL');
            const logger = new Logger(RealtimeModule.name);

            logger.log(
              `Fanning realtime out on "${config.get('REALTIME_CHANNEL')}".`,
            );

            const redis = new Redis(url, { retryStrategy: reconnectAfter });

            // ioredis prints "missing 'error' handler on this Redis client"
            // and re-raises otherwise, so an unreachable Redis becomes an
            // unhandled error event rather than a line saying what is wrong.
            // Realtime is best effort: a bus that cannot connect must not take
            // the process with it.
            redis.on('error', (failure: Error) => {
              logger.warn(`Realtime Redis: ${failure.message}`);
            });

            return redis;
          },
        },
        {
          provide: REALTIME_CHANNEL,
          inject: [BaseConfig],
          useFactory: (config: BaseConfig): string =>
            config.get('REALTIME_CHANNEL'),
        },
        RealtimeBus,
      ],
      exports: [RealtimeBus],
    };
  }
}
