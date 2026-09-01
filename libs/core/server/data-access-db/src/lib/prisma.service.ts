import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client.js';

/**
 * The single Prisma client for the service.
 *
 * Nothing outside this library imports the generated client (spec section 4 rule 5),
 * and nothing outside it sees `Prisma.*` types (rule 5b) - swapping the ORM
 * must mean rewriting this library, not the whole codebase.
 *
 * Prisma 7 requires an explicit driver adapter for SQL providers; the pg pool
 * is therefore ours to configure and ours to close.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env['DATABASE_URL'];

    if (!connectionString) {
      // Failing here beats failing on the first query in a request.
      throw new Error('DATABASE_URL is required to create the database client');
    }

    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    // Connecting eagerly turns an unreachable database into a boot failure
    // instead of a failure on whichever request happens to need it first.
    await this.$connect();
    this.logger.log('Database connection established');
  }
}
