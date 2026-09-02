import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';
import { activeTransaction } from './transaction/transaction-context.js';

/**
 * Members that stay reachable while a transaction is active: lifecycle,
 * opening the transaction itself, and what Nest inspects on every provider.
 */
const ALLOWED_DURING_TRANSACTION = new Set([
  '$connect',
  '$disconnect',
  '$on',
  '$transaction',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationShutdown',
  'constructor',
  'then',
  'logger',
]);

/**
 * The single Prisma client for the service — the *root* client.
 *
 * Nothing outside this library imports the generated client,
 * and nothing outside it sees `Prisma.*` types - swapping the ORM
 * must mean rewriting this library, not the whole codebase. Work goes through
 * `Database` (transaction/database.ts); this class exists to own the
 * connection pool.
 *
 * The instance is wrapped in a proxy that refuses queries while a transaction
 * is active. A query on the root client would run on a different connection,
 * outside the transaction and its tenant GUCs, and under RLS would return
 * nothing — silently. The invariant is enforced by the runtime, not by review.
 *
 * Prisma 7 requires an explicit driver adapter for SQL providers; the pg pool
 * is therefore ours to configure and ours to close.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env['DATABASE_URL'];

    if (!connectionString) {
      // Failing here beats failing on the first query in a request.
      throw new Error('DATABASE_URL is required to create the database client');
    }

    super({ adapter: new PrismaPg({ connectionString }) });

    return guardRootClient(this);
  }

  async onModuleInit(): Promise<void> {
    // Connecting eagerly turns an unreachable database into a boot failure
    // instead of a failure on whichever request happens to need it first.
    await this.$connect();
    await this.refuseUnboundConnection();
    this.logger.log('Database connection established');
  }

  /**
   * Refuses to serve traffic on a connection that row-level security cannot
   * bind.
   *
   * `FORCE ROW LEVEL SECURITY` binds table owners, never superusers or
   * `BYPASSRLS` roles: connected as one, every tenant policy would be
   * advisory and nothing would say so. Phase 3 depends on this, so it is a
   * boot condition rather than a review item.
   */
  private async refuseUnboundConnection(): Promise<void> {
    const [role] = await this.$queryRaw<
      { name: string; isSuper: boolean; bypasses: boolean }[]
    >`
      SELECT current_user AS name,
             rolsuper AS "isSuper",
             rolbypassrls AS bypasses
      FROM pg_roles WHERE rolname = current_user`;

    if (role?.isSuper || role?.bypasses) {
      throw new Error(
        `The database connection uses "${role.name}", which row-level security cannot bind ` +
          '(superuser or BYPASSRLS). Point DATABASE_URL at app_user. ' +
          'If the role has no login, the database volume predates the roles migration: ' +
          'run `docker compose down -v` and start again.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // The pg pool is ours to configure and ours to close (Prisma 7 driver
    // adapters). Without this, `enableShutdownHooks` leaves sockets open and a
    // rolling deploy holds connections the new instance needs.
    await this.$disconnect();
  }
}

function guardRootClient(client: PrismaService): PrismaService {
  return new Proxy(client, {
    get(target, property) {
      if (
        typeof property === 'string' &&
        !ALLOWED_DURING_TRANSACTION.has(property) &&
        activeTransaction()
      ) {
        throw new Error(
          `The root database client was used (${property}) while a transaction is active. ` +
            'Use db.tenant() or db.system() so the work runs inside it.',
        );
      }

      // Read and bind against the real instance: Prisma keeps private state
      // that a proxied `this` would not reach.
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
