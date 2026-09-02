import { AsyncLocalStorage } from 'node:async_hooks';

import type { Prisma } from '../../generated/prisma/client.js';
import type { TenantContext } from '@workspace/core-server-core';

/** The client handed to a transaction callback by Prisma. Never leaves this library. */
export type TransactionClient = Prisma.TransactionClient;

export interface ActiveTransaction {
  readonly client: TransactionClient;
  readonly context: TenantContext;
}

/**
 * The transaction currently in flight for this async call chain.
 *
 * AsyncLocalStorage follows awaits, callbacks and timers, so a repository three
 * calls deep finds the same transaction the use case opened — without every
 * function in between having to pass `tx` along.
 */
const storage = new AsyncLocalStorage<ActiveTransaction>();

export function activeTransaction(): ActiveTransaction | undefined {
  return storage.getStore();
}

export function runInTransaction<T>(
  active: ActiveTransaction,
  work: () => Promise<T>,
): Promise<T> {
  return storage.run(active, work);
}
