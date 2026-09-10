import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { WorkerConfig } from '@workspace/core-server-core';
import {
  Database,
  ErasureRepository,
} from '@workspace/core-server-data-access-db';
import type { JobDefinition } from '@workspace/core-server-queue';

/** The factory that opens a connection as `erasure_role`. */
export const ERASURE_DATABASE = Symbol('ERASURE_DATABASE');

/** How many people one run erases before waiting for the next. */
const MAX_PER_RUN = 100;

const HOUR_MS = 60 * 60 * 1_000;

/**
 * The recurring erasure has no payload: who is due is decided by the clock and
 * by the rows. It is still a schema, because the envelope contract is that
 * every job has one.
 */
export const erasureSweep: JobDefinition<Record<string, never>> = {
  queue: 'erasure',
  name: 'erase',
  payload: z.object({}).strict(),
};

/**
 * Erases the people whose grace window has passed.
 *
 * **On its own connection, as `erasure_role`, opened for the run and closed
 * after it.** Not a pool: this runs once a day, and a third permanent pool
 * would change the worker's boot arithmetic — which asserts that the
 * consumers plus the relay fit inside `WORKER_DATABASE_POOL_MAX` — to buy
 * nothing. A short-lived client with one connection is the honest shape for
 * work that happens daily.
 *
 * The role is what makes the audit trail immutable to everything else:
 * `app_user` holds no grant on `audit_records` at all and `worker_user` holds
 * `INSERT, SELECT`. If a consumer could update it, the trail's immutability
 * would be a convention rather than a permission.
 */
@Injectable()
export class ErasureSweep {
  private readonly logger = new Logger(ErasureSweep.name);
  private readonly config: WorkerConfig;
  private readonly openErasureDatabase: () => Promise<{
    db: Database;
    close: () => Promise<void>;
  }>;
  private readonly erasure: ErasureRepository;

  constructor(
    @Inject(WorkerConfig) config: WorkerConfig,
    @Inject(ErasureRepository) erasure: ErasureRepository,
    @Inject(ERASURE_DATABASE) open: () => Promise<{
      db: Database;
      close: () => Promise<void>;
    }>,
  ) {
    this.config = config;
    this.erasure = erasure;
    this.openErasureDatabase = open;
  }

  /** How often this runs, and therefore part of the schedule's identity. */
  get intervalMs(): number {
    return this.config.get('ERASURE_SWEEP_INTERVAL_HOURS') * HOUR_MS;
  }

  async run(): Promise<number> {
    const graceDays = this.config.get('ERASURE_GRACE_DAYS');
    const { db, close } = await this.openErasureDatabase();

    try {
      const due = await db.withSystemTransaction(() =>
        this.erasure.dueForErasure(graceDays, MAX_PER_RUN),
      );

      if (due.length === 0) {
        return 0;
      }

      let erased = 0;

      for (const userId of due) {
        // One transaction each, not one for the batch: an erasure that fails
        // halfway through a hundred people must not undo the ninety-nine that
        // worked, and each is independently meaningful.
        //
        // The window goes with the id because the batch was read in an earlier
        // transaction: somebody who cancels while this loop is working must not
        // be erased from a list that was true a minute ago.
        try {
          const outcome = await db.withSystemTransaction(() =>
            this.erasure.erase(userId, graceDays),
          );
          erased += 1;

          this.logger.log(
            `Erased ${outcome.userId} and anonymised ${outcome.auditRecordsAnonymised} ` +
              'audit record(s). This cannot be undone.',
          );
        } catch (failure) {
          const reason =
            failure instanceof Error ? failure.message : String(failure);
          // Reported and skipped rather than abandoning the run: the next one
          // finds it again, and one unerasable row must not hold up everybody
          // else's right to be forgotten.
          this.logger.error(`Could not erase ${userId}: ${reason}`);
        }
      }

      return erased;
    } finally {
      // Every path, including the one that threw. A daily job that leaked a
      // connection would exhaust the server's in a few months, and the failure
      // would arrive somewhere else entirely.
      await close();
    }
  }
}

