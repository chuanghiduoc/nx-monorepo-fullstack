import { Global, Module } from '@nestjs/common';

import { DemoItemRepository } from './demo-items/demo-item.repository.js';
import { IdempotencyStore } from './idempotency.store.js';
import { PrismaService } from './prisma.service.js';
import { Database } from './transaction/database.js';

/**
 * Everything that talks to PostgreSQL, wired once.
 *
 * `PrismaService` is provided here and exported nowhere: the root client is
 * an implementation detail of this library. Feature modules receive
 * `Database` (to own a transaction) and repositories (to do work inside one).
 */
@Global()
@Module({
  providers: [PrismaService, Database, IdempotencyStore, DemoItemRepository],
  exports: [Database, IdempotencyStore, DemoItemRepository],
})
export class DatabaseModule {}
