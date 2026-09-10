import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

/** When somebody asked to be forgotten, if they did. */
export interface ErasureStatus {
  readonly requestedAt: Date | null;
}

/**
 * A person asking to be forgotten, and changing their mind.
 *
 * Separate from `ErasureRepository`, which does the erasing: this runs in a
 * **request**, as `app_user`, and only ever writes a timestamp. The role that
 * actually deletes anything is `erasure_role`, and nothing reachable from an
 * HTTP handler holds it.
 *
 * That split is the point. A route that could erase would be a route an
 * injection could erase through, and the thirty-day window would be worth
 * nothing.
 */
@Injectable()
export class ErasureRequestRepository {
  /**
   * Marks an account for erasure, unless it already is.
   *
   * Returns the timestamp that is now in force — the existing one when there
   * was one, so asking twice does not quietly extend the window. That would be
   * the wrong direction for a promise: a person who asked on the first and
   * again on the tenth expects the first date to hold.
   */
  async request(userId: string): Promise<Date> {
    const rows = await this.client().$queryRaw<{ deleted_at: Date }[]>`
      UPDATE "user"
         SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
       WHERE id = ${userId}::uuid
      RETURNING deleted_at`;

    const requestedAt = rows[0]?.deleted_at;

    if (requestedAt === undefined) {
      throw new Error(`No such user: ${userId}`);
    }

    return requestedAt;
  }

  /**
   * Takes an account back out of the queue.
   *
   * Returns whether it was in it. There is no window check here: this
   * repository cannot see whether the job has already run, and if it has, the
   * row is gone and the update matches nothing — which is the same answer.
   */
  async cancel(userId: string): Promise<boolean> {
    const cancelled = await this.client().$executeRaw`
      UPDATE "user"
         SET deleted_at = NULL, updated_at = now()
       WHERE id = ${userId}::uuid AND deleted_at IS NOT NULL`;

    return cancelled > 0;
  }

  async statusOf(userId: string): Promise<ErasureStatus> {
    const rows = await this.client().$queryRaw<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM "user" WHERE id = ${userId}::uuid`;

    const row = rows[0];

    if (row === undefined) {
      throw new Error(`No such user: ${userId}`);
    }

    return { requestedAt: row.deleted_at };
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'An erasure request is written inside the request’s transaction. ' +
          'Wrap the call in withRequestTransaction(...).',
      );
    }

    return active.client;
  }
}
