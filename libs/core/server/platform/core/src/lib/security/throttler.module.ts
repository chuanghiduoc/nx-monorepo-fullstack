import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppConfig } from '../config/config.module.js';
import { ThrottlerRedisStorage } from './throttler-storage.js';

/**
 * The rate limiter's Redis, owned by the container.
 *
 * A module of its own so that the storage is a **provider** rather than a
 * value built inside `forRootAsync`'s factory. Nest calls lifecycle hooks on
 * providers it constructed; an object a factory returned is not one, so
 * `onApplicationShutdown` would never run and the connection would stay open —
 * which is the bug this shape exists to prevent, not a stylistic preference.
 */
@Module({
  providers: [
    {
      provide: ThrottlerRedisStorage,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new ThrottlerRedisStorage(config.get('REDIS_CRITICAL_URL')),
    },
  ],
  exports: [ThrottlerRedisStorage],
})
export class ThrottlerStorageModule {}

/**
 * Rate limiting backed by Redis.
 *
 * Counters live in the critical Redis role, not the cache: an eviction here
 * would silently reset every limit, which is exactly what an abusive client
 * would want. That instance runs with `noeviction` for the same reason the
 * queue does.
 *
 * In-memory counters would also be wrong the moment a second replica exists —
 * each one would allow the full quota.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerStorageModule],
      inject: [AppConfig, ThrottlerRedisStorage],
      useFactory: (config: AppConfig, storage: ThrottlerRedisStorage) => ({
        throttlers: [
          {
            ttl: config.get('THROTTLE_TTL_MS'),
            limit: config.get('THROTTLE_LIMIT'),
          },
        ],
        storage,
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppThrottlerModule {}
