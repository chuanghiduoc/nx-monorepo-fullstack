import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

/** What one erasure did, for the log and for the tests. */
export interface ErasureOutcome {
  readonly userId: string;
  readonly auditRecordsAnonymised: number;
}

/**
 * Erasing a person, and everything that names them.
 *
 * Runs as `erasure_role` — the only role that may delete an identity row and
 * the only one that may edit an audit record. Both halves are in **one
 * transaction**, and that is the correction this design is built around: split
 * across two roles they would be two connections and therefore two
 * transactions, and a crash between them leaves a deleted user whose audit
 * rows still name them. Unrecoverably, because once the user row is gone there
 * is no list of ids left to anonymise from.
 */
@Injectable()
export class ErasureRepository {
  /**
   * The users whose grace window has passed.
   *
   * Bounded, and read inside the same transaction that erases them so nothing
   * can mark one undeleted in between.
   */
  async dueForErasure(graceDays: number, limit: number): Promise<string[]> {
    const cutoff = cutoffFor(graceDays);

    const rows = await this.client().$queryRaw<{ id: string }[]>`
      SELECT id FROM "user"
       WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}
       ORDER BY deleted_at
       LIMIT ${limit}`;

    return rows.map((row) => row.id);
  }

  /**
   * Removes one person and takes their name out of the trail.
   *
   * **The trail is anonymised first.** After the delete there is no way to find
   * the rows: `audit_records.actor_id` deliberately has no foreign key — a
   * cascade there would destroy the evidence the table exists to keep — so
   * nothing would point at them any more.
   *
   * `detail` is replaced wholesale rather than edited. It is whatever the event
   * carried, and no code here can know which keys of an arbitrary jsonb
   * identify a person; anything that tried would be a guess that fails
   * silently on the first event type nobody thought about. The event type, the
   * aggregate and the timestamps live in their own columns, so the trail still
   * says what happened and when — only who is gone.
   *
   * The identity tables go with the user through `ON DELETE CASCADE`:
   * `session`, `account`, `member`, `invitation`, `twofactor`. None of them
   * means anything without the person.
   *
   * **The delete carries the same window the read did, and it has to.** The
   * sweep reads a batch in one transaction and erases each person in another,
   * so a request cancelled in between — which is a route anybody can call,
   * `DELETE /v1/privacy/erasure` — arrives after this id is already on the
   * list. Deleting by id alone honoured a list that had gone stale and removed
   * an account whose owner had just changed their mind, irreversibly, with the
   * cancellation reporting success. The predicate is what makes PostgreSQL
   * re-check the row it locked: a concurrent cancellation either commits first
   * and this matches nothing, or commits after and finds the row already gone.
   */
  async erase(userId: string, graceDays: number): Promise<ErasureOutcome> {
    const client = this.client();
    const cutoff = cutoffFor(graceDays);

    const anonymised = await client.$executeRaw`
      UPDATE "audit_records"
         SET actor_id = NULL,
             detail = jsonb_build_object(
               'erased', true,
               'erasedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
       WHERE actor_id = ${userId}::uuid`;

    const removed = await client.$executeRaw`
      DELETE FROM "user"
       WHERE id = ${userId}::uuid
         AND deleted_at IS NOT NULL
         AND deleted_at < ${cutoff}`;

    if (removed === 0) {
      // Somebody else erased it, or its owner cancelled the request while this
      // sweep was working through the batch. Not a failure — but the
      // anonymisation above has to roll back with it, which throwing is what
      // does.
      throw new Error(
        `User ${userId} was gone, or no longer due for erasure, before this erasure reached it; ` +
          'nothing was changed.',
      );
    }

    return { userId, auditRecordsAnonymised: anonymised };
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'An erasure removes a person and anonymises the trail in one transaction. ' +
          'Wrap the call in withSystemTransaction(...) on the erasure connection.',
      );
    }

    return active.client;
  }
}

/**
 * The moment a request has to predate to be due.
 *
 * One function for the read and the delete, because two spellings of the same
 * arithmetic are two things that can drift apart — and if they did, the delete
 * would either miss rows the read promised or take rows the read never offered.
 */
function cutoffFor(graceDays: number): Date {
  return new Date(Date.now() - graceDays * 24 * 60 * 60 * 1_000);
}
