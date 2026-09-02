import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma.service.js';

/**
 * The one sanctioned way for an authentication library to reach the database.
 *
 * better-auth's Prisma adapter calls `client[model].findFirst(...)` on
 * whatever client it is handed. It is handed the **proxied root client** on
 * purpose: the Phase 2 guard then refuses any call made while a transaction
 * is active, which is exactly the mistake worth catching. Measured in the
 * Task 0 spike: a sign-up inside `withTenantTransaction` fails with "The root
 * database client was used", while the same call outside one reaches
 * PostgreSQL (ADR-0003).
 *
 * The type is deliberately opaque. Nothing outside this library learns that
 * the object is a Prisma client, so spec §4 rule 5 still holds.
 */
export type AuthDatabase = object;

@Injectable()
export class AuthDatabaseProvider {
  readonly client: AuthDatabase;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.client = prisma;
  }
}
