import { Inject, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import {
  SYSTEM_CONTEXT,
  currentRequestContext,
  describeTenantContext,
  sameTenantContext,
  type TenantContext,
  type TenantScopedContext,
} from '@workspace/core-server-core';
import { TENANT_SCOPED_DELEGATES } from '../tenancy/tenant-scoped-models.js';
import { guardTenantModels } from '../tenancy/tenant-guard.js';
import {
  activeTransaction,
  runInTransaction,
  type TransactionClient,
} from './transaction-context.js';

export type IsolationLevel =
  'read-committed' | 'repeatable-read' | 'serializable';

export interface TransactionOptions {
  /** Upper bound on the whole callback; Prisma's default is 5 s. Keep it short. */
  readonly timeoutMs?: number;
  /** How long to wait for a connection from the pool; Prisma's default is 2 s. */
  readonly maxWaitMs?: number;
  readonly isolation?: IsolationLevel;
}

const ISOLATION: Record<IsolationLevel, Prisma.TransactionIsolationLevel> = {
  'read-committed': Prisma.TransactionIsolationLevel.ReadCommitted,
  'repeatable-read': Prisma.TransactionIsolationLevel.RepeatableRead,
  serializable: Prisma.TransactionIsolationLevel.Serializable,
};

/**
 * The only sanctioned way to touch the database.
 *
 * `withTenantTransaction` and `withSystemTransaction` own the transaction and
 * the tenant GUCs. Everything inside them reaches the transaction client via
 * `tenant` / `system`, which read it from async context — so a repository
 * three calls deep runs on the same transaction as the use case that opened
 * it, and Phase 3's RLS policies see the GUCs on every query.
 *
 * The callbacks deliberately receive no client: a `tx` parameter would carry
 * a Prisma type into feature code, and swapping the ORM would then break
 * every caller.
 */
@Injectable()
export class Database {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /** Tenant-scoped work: sets `app.current_org_id` / `app.current_user_id` for the transaction. */
  withTenantTransaction<T>(
    context: TenantScopedContext,
    work: () => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return this.run(context, work, options);
  }

  /**
   * Tenant-scoped work for the tenant the current request resolved to.
   *
   * The explicit form of the same thing: a request already knows who it is
   * acting as, and repeating that at every call site invites a mismatch. It is
   * a separate method rather than a fallback inside `tenant()` because
   * `tenant()` is synchronous — making it open a transaction would turn two
   * consecutive calls into two transactions with nothing atomic between them,
   * and nothing at the call site would say so.
   */
  // `async` so the missing-context error reaches the caller's `.catch()`
  // rather than being thrown before the promise exists.
  async withRequestTransaction<T>(
    work: () => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const context = currentRequestContext();

    if (!context) {
      throw new Error(
        'There is no request context here, so there is no tenant to run as. ' +
          'Inside a job or a script, name the tenant with withTenantTransaction(context, ...) ' +
          'or use withSystemTransaction(...).',
      );
    }

    if (context.tenant.kind === 'system') {
      return this.withSystemTransaction(work, options);
    }

    return this.withTenantTransaction(context.tenant, work, options);
  }

  /** Global work (relays, schedulers, idempotency): no tenant GUC is set. */
  withSystemTransaction<T>(
    work: () => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return this.run(SYSTEM_CONTEXT, work, options);
  }

  /**
   * The active tenant transaction. Throws outside one: with RLS FORCE a query
   * that ran on the root client would return nothing, silently, and "the
   * report is empty" is a far worse failure than a stack trace.
   */
  tenant(): TransactionClient {
    const active = activeTransaction();
    if (!active || active.context.kind === 'system') {
      throw new Error(
        active
          ? 'A system transaction is active; tenant-scoped work cannot join it. ' +
              'Open a withTenantTransaction(context, ...) instead.'
          : 'No tenant transaction is active: wrap the call in withTenantTransaction(context, ...)',
      );
    }
    return active.client;
  }

  system(): TransactionClient {
    const active = activeTransaction();
    if (!active || active.context.kind !== 'system') {
      throw new Error(
        active
          ? 'A tenant transaction is active; system work cannot join it. ' +
              'Open a withSystemTransaction(...) instead.'
          : 'No system transaction is active: wrap the call in withSystemTransaction(...)',
      );
    }

    // A system transaction sets no tenant GUC, so a tenant-scoped table read
    // through it comes back empty rather than wrong. Empty is worse: it reads
    // exactly like an empty table. The guard makes it say so instead.
    return guardTenantModels(active.client, TENANT_SCOPED_DELEGATES);
  }

  // `async` so a caller's `.catch` sees the nesting error too: a synchronous
  // throw from here would escape the promise chain.
  private async run<T>(
    context: TenantContext,
    work: () => Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const active = activeTransaction();

    if (active) {
      // Nesting joins the transaction in flight. Changing identity part-way
      // would silently run the inner work under the outer tenant's GUCs.
      if (!sameTenantContext(active.context, context)) {
        throw new Error(
          `Cannot run work as ${describeTenantContext(context)} inside a transaction for ` +
            `${describeTenantContext(active.context)}: different tenant context`,
        );
      }

      // Joining cannot change the isolation level of a transaction that has
      // already begun; silently running at the weaker level would be the kind
      // of thing nobody notices until an anomaly appears in production.
      if (options.isolation) {
        throw new Error(
          `Cannot request isolation "${options.isolation}" inside a transaction that is already open; ` +
            'open the outer transaction with that level instead',
        );
      }

      return work();
    }

    return this.prisma.$transaction(
      async (client) => {
        await applyTenantGucs(client, context);
        return runInTransaction({ client, context }, work);
      },
      {
        timeout: options.timeoutMs,
        maxWait: options.maxWaitMs,
        isolationLevel: options.isolation
          ? ISOLATION[options.isolation]
          : undefined,
      },
    );
  }
}

/**
 * `set_config(..., true)` is transaction-local: the values vanish at COMMIT or
 * ROLLBACK, so a pooled connection never carries one tenant's identity into
 * the next request — the property that makes PgBouncer transaction mode safe.
 */
async function applyTenantGucs(
  client: TransactionClient,
  context: TenantContext,
): Promise<void> {
  switch (context.kind) {
    case 'org':
      await client.$queryRaw`
        SELECT set_config('app.current_org_id', ${context.orgId}, true),
               set_config('app.current_user_id', ${context.userId}, true)`;
      return;
    case 'user':
      await client.$queryRaw`
        SELECT set_config('app.current_org_id', '', true),
               set_config('app.current_user_id', ${context.userId}, true)`;
      return;
    case 'system':
      return;
    default:
      return assertNever(context);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled tenant context: ${JSON.stringify(value)}`);
}
