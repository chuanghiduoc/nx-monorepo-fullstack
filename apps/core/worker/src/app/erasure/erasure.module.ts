import { Module } from '@nestjs/common';

import {
  Database,
  ErasureRepository,
  PrismaService,
} from '@workspace/core-server-data-access-db';

import { ERASURE_DATABASE, ErasureSweep } from './erasure.job.js';

/**
 * Erasure, and the connection it borrows.
 *
 * The factory returns a **new** client each time rather than a provider that
 * holds one. That is deliberate: erasure runs once a day, and a permanent
 * third pool would count against `WORKER_DATABASE_POOL_MAX` — which the worker
 * asserts at boot — every hour of the twenty-three it is doing nothing.
 *
 * It also keeps the blast radius small. `erasure_role` is the only role that
 * may delete a person or edit an audit record; a client that exists only for
 * the minute the job runs is a client nothing else can reach into.
 */
@Module({
  providers: [
    ErasureRepository,
    ErasureSweep,
    {
      provide: ERASURE_DATABASE,
      useValue: async () => {
        const prisma = new PrismaService(
          'ERASURE_DATABASE_URL',
          'ERASURE_DATABASE_POOL_MAX',
        );
        // `onModuleInit` rather than a bare `$connect`: it also refuses a
        // connection row-level security cannot bind, which is the check that
        // would catch somebody pointing this at the owner by mistake — and
        // this is the one role that could then quietly rewrite the trail.
        await prisma.onModuleInit();

        return {
          db: new Database(prisma),
          close: () => prisma.$disconnect(),
        };
      },
    },
  ],
  exports: [ErasureSweep],
})
export class ErasureModule {}
