import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Redis } from 'ioredis';

import { AppConfig } from '../config/config.module.js';

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
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            ttl: config.get('THROTTLE_TTL_MS'),
            limit: config.get('THROTTLE_LIMIT'),
          },
        ],
        storage: new ThrottlerStorageRedisService(
          new Redis(config.get('REDIS_CRITICAL_URL')),
        ),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppThrottlerModule {}
