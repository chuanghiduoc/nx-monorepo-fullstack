import { Global, Module, type DynamicModule } from '@nestjs/common';

import { AuditRepository } from './audit/audit.repository.js';
import { AuthDatabaseProvider } from './auth/auth-database.js';
import {
  DATABASE_POOL_VARIABLE,
  DATABASE_URL_VARIABLE,
} from './database.tokens.js';
import { DemoItemRepository } from './demo-items/demo-item.repository.js';
import { IdempotencyStore } from './idempotency.store.js';
import { NoteRepository } from './notes/note.repository.js';
import { OutboxRepository } from './outbox/outbox.repository.js';
import { ProcessedEventRepository } from './outbox/processed-event.repository.js';
import { OrgSettingsRepository } from './org-settings/org-settings.repository.js';
import { PrismaService } from './prisma.service.js';
import { FileRepository } from './files/file.repository.js';
import { FlagRepository } from './flags/flag.repository.js';
import { QuotaRepository } from './quota/quota.repository.js';
import { WebhookRepository } from './webhooks/webhook.repository.js';
import { AiRepository } from './ai/ai.repository.js';
import { RetentionRepository } from './retention/retention.repository.js';
import { Database } from './transaction/database.js';

const EXPORTED = [
  AiRepository,
  AuditRepository,
  Database,
  FileRepository,
  FlagRepository,
  IdempotencyStore,
  DemoItemRepository,
  OrgSettingsRepository,
  NoteRepository,
  OutboxRepository,
  ProcessedEventRepository,
  QuotaRepository,
  RetentionRepository,
  WebhookRepository,
  AuthDatabaseProvider,
];

/**
 * Everything that talks to PostgreSQL, wired once.
 *
 * `PrismaService` is provided here and exported nowhere: the root client is
 * an implementation detail of this library. Feature modules receive
 * `Database` (to own a transaction) and repositories (to do work inside one).
 *
 * `forRoot` takes the names of the variables holding the connection string and
 * the pool size, because the API and the worker connect as different database
 * roles with different concurrency — and a single shared variable would give
 * whichever process read it the other's rights, or the other's share of the
 * connections.
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(
    connectionVariable: string,
    poolVariable: string,
  ): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_URL_VARIABLE, useValue: connectionVariable },
        { provide: DATABASE_POOL_VARIABLE, useValue: poolVariable },
        PrismaService,
        ...EXPORTED,
      ],
      exports: EXPORTED,
    };
  }
}
