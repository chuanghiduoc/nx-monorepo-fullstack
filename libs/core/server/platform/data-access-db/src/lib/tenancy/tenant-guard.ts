import type { TransactionClient } from '../transaction/transaction-context.js';

/**
 * Raised when a tenant-scoped table is reached with no tenant to scope it to.
 *
 * A distinct type so a caller can tell it apart from a database failure: this
 * one always means the calling code forgot something.
 */
export class NoTenantContextError extends Error {
  constructor(model: string) {
    super(
      `${model} belongs to a tenant, and this transaction has none. ` +
        'Use withRequestTransaction(...) inside a request, or name the tenant with ' +
        'withTenantTransaction(context, ...).',
    );
    this.name = 'NoTenantContextError';
  }
}

/**
 * Wraps a system transaction's client so that reaching a tenant-scoped table
 * through it fails loudly.
 *
 * Under a row-level security policy, such a query returns an empty result and
 * raises nothing — indistinguishable from an empty table, and the kind of bug
 * that reaches production as "the list is blank for some users". This turns it
 * into a stack trace naming the model.
 *
 * **Why here and not a Prisma client extension.** The obvious implementation
 * is `$extends` with an `$allOperations` hook that checks the async context.
 * It does not work: Prisma runs the hook outside the asynchronous context the
 * transaction was opened in, so the store is empty and *every* query looks
 * unscoped — measured, with the guard rejecting reads made inside a perfectly
 * valid tenant transaction. An accessor, by contrast, is called from the
 * caller's own context, where the answer is known.
 *
 * It guards property access, not SQL: `$queryRaw` goes through untouched, and
 * that stays the author's responsibility. The policy still applies to it.
 */
export function guardTenantModels(
  client: TransactionClient,
  scopedModels: ReadonlySet<string>,
): TransactionClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (typeof property === 'string' && scopedModels.has(property)) {
        throw new NoTenantContextError(property);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
