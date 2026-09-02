import { AsyncLocalStorage } from 'node:async_hooks';

import type { Principal } from '@workspace/core-server-authz';

import type { TenantContext } from './tenant-context.js';

/**
 * Who is asking, and what they may see, for the length of one request.
 *
 * Resolved once, before any transaction opens, and frozen for the rest of the
 * request: a value that could change halfway through would mean a service
 * reading one tenant and writing another.
 */
export interface RequestContext {
  readonly principal: Principal;
  readonly tenant: TenantContext;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Runs the rest of the request inside `context`.
 *
 * `continue` is a Fastify hook's `done` callback, and calling it *inside*
 * `storage.run` is what carries the store into the route handler. Neither
 * alternative works: `run(store, () => {})` ends the moment the hook returns,
 * and `enterWith` in an async hook binds a context that Fastify's own
 * continuation does not inherit — measured, both leave the handler seeing
 * nothing.
 */
export function runRequestInContext(
  context: RequestContext,
  next: () => void,
): void {
  storage.run(context, next);
}

/** For tests and for work that has no request: runs `work` under `context`. */
export function withRequestContext<T>(
  context: RequestContext,
  work: () => T,
): T {
  return storage.run(context, work);
}
