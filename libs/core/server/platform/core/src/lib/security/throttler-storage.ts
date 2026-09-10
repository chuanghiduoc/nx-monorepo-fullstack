import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Redis } from 'ioredis';

import { closeRedis } from '../shutdown.js';

/**
 * The throttler's counters, and the connection they live on.
 *
 * A class rather than an inline `new ThrottlerStorageRedisService(new Redis(…))`
 * inside the module factory, because a connection created there belongs to
 * nobody: nothing closes it, and a process that has decided to stop is left
 * with an open socket. Under a test that is a suite which will not exit; in a
 * deployment it is a client the server sees vanish rather than say goodbye.
 *
 * It owns the client it creates, which is the whole reason it exists.
 */
@Injectable()
export class ThrottlerRedisStorage
  extends ThrottlerStorageRedisService
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(ThrottlerRedisStorage.name);
  private readonly client: Redis;

  constructor(url: string) {
    const client = new Redis(url);
    super(client);
    this.client = client;
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.client, 'The rate limiter’s Redis', this.logger);
  }
}
