import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

export interface FlagRow {
  readonly key: string;
  readonly value: unknown;
}

/**
 * The two tables a flag is read from.
 *
 * Reads only. Neither role holds INSERT or UPDATE here: a flag the application
 * can rewrite is a flag an injection can rewrite, and a flag is precisely the
 * switch somebody would most want to flip. Changes come from a migration or an
 * operator with the owner connection until there is an administrative route
 * that brings its own grant and its own authorization.
 *
 * Values are `unknown` rather than a Prisma JSON type. The library that
 * evaluates them is tagged `type:data-access` but not `driver:orm`, so a
 * `Prisma.JsonValue` in this signature would fail its lint — and the natural
 * way to make that error go away is to widen the boundary.
 */
@Injectable()
export class FlagRepository {
  /**
   * Every global default, in one read.
   *
   * The whole table, because it is small by construction — one row per flag
   * the product has — and because the caller caches it. Paging it would trade
   * a bounded read for several unbounded ones.
   */
  async allGlobal(): Promise<FlagRow[]> {
    const rows = await this.client().$queryRaw<{ key: string; value: unknown }[]>`
      SELECT key, value FROM "feature_flags"`;

    return rows;
  }

  /**
   * One organization's answer for one flag, if it has one.
   *
   * A primary-key lookup, deliberately not cached: turning a flag on for one
   * customer is what happens during an incident, and taking effect on the next
   * request rather than at the end of a cache window is the whole value of it.
   *
   * **The organization is named in the predicate, not left to the policy.**
   * Leaving it out looks tidier and is wrong: the worker reads this table
   * under a policy that shows it every tenant, so an unfiltered lookup would
   * return whichever row the plan happened to reach first. Under a tenant
   * transaction the policy still bounds the same query, so the two agree and
   * neither is load-bearing alone.
   */
  async overrideFor(orgId: string, key: string): Promise<FlagRow | undefined> {
    const rows = await this.client().$queryRaw<{ key: string; value: unknown }[]>`
      SELECT key, value FROM "flag_overrides"
       WHERE org_id = ${orgId}::uuid AND key = ${key}`;

    return rows[0];
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'A flag is read inside the transaction that is about to act on it — a tenant one to see ' +
          'that tenant’s overrides. Wrap the call in withTenantTransaction(context, ...) or ' +
          'withSystemTransaction(...).',
      );
    }

    return active.client;
  }
}
