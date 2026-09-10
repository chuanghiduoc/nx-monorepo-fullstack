import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  StandardResolutionReasons,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';

import {
  Database,
  FlagRepository,
} from '@workspace/core-server-data-access-db';
import { currentRequestContext } from '@workspace/core-server-core';

import { GlobalFlagCache } from './global-flags.cache.js';

/**
 * The key an evaluation context carries an organization under.
 *
 * A caller that already knows which tenant it is acting for — a worker
 * handling a job, which is deliberately system-scoped — passes it here. A
 * request does not have to: the request context already knows.
 */
export const ORG_TARGETING_KEY = 'orgId';

/**
 * Flags, out of this database, behind OpenFeature's `Provider` interface.
 *
 * The interface is the cheap part and the reason it is here: every hosted flag
 * vendor publishes an OpenFeature provider, so replacing this one is a line in
 * a module rather than an edit at every call site.
 *
 * What it deliberately does **not** do is call `OpenFeature.setProvider`. That
 * is process-global mutable state, which every test then has to unwind and two
 * suites in one process cannot share. A Nest application already has a
 * container for exactly this; anyone who wants the global client can write
 * that one line in their own bootstrap.
 *
 * **An evaluation never throws.** Every failure — an unknown key, a value of
 * the wrong type, a database that is not answering — resolves to the caller's
 * default with a reason. A flag store that throws turns one outage into every
 * request failing, and a kill switch that fails closed is not a kill switch.
 */
@Injectable()
export class DatabaseFlagProvider implements Provider {
  readonly runsOn = 'server';
  readonly metadata = { name: 'database' } as const;

  private readonly cache: GlobalFlagCache;
  private readonly flags: FlagRepository;
  private readonly db: Database;

  constructor(
    @Inject(GlobalFlagCache) cache: GlobalFlagCache,
    @Inject(FlagRepository) flags: FlagRepository,
    @Inject(Database) db: Database,
  ) {
    this.cache = cache;
    this.flags = flags;
    this.db = db;
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolve(flagKey, defaultValue, context, isBoolean);
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    return this.resolve(flagKey, defaultValue, context, isString);
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    return this.resolve(flagKey, defaultValue, context, isNumber);
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    return this.resolve(flagKey, defaultValue, context, isObjectOrArray<T>);
  }

  /**
   * One evaluation: the tenant's answer if it has one, then the global
   * default, then the caller's.
   *
   * The override is looked up first and short-circuits, so an incident switch
   * for one customer does not depend on the global row existing at all.
   */
  private async resolve<T>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    matches: (value: unknown) => value is T,
  ): Promise<ResolutionDetails<T>> {
    const orgId = this.organizationFor(context);

    try {
      if (orgId !== undefined) {
        const override = await this.overrideFor(orgId, flagKey);

        if (override !== undefined) {
          return typed(
            override.value,
            defaultValue,
            matches,
            StandardResolutionReasons.TARGETING_MATCH,
          );
        }
      }

      const global = await this.cache.get(flagKey);

      if (global === undefined) {
        // Not an error: a key nobody has configured resolves to the caller's
        // default, which is what makes deleting a retired flag from the table
        // a safe operation rather than an outage in everything that still
        // names it.
        return {
          value: defaultValue,
          reason: StandardResolutionReasons.DEFAULT,
          errorCode: ErrorCode.FLAG_NOT_FOUND,
        };
      }

      return typed(
        global,
        defaultValue,
        matches,
        StandardResolutionReasons.STATIC,
      );
    } catch (failure) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.GENERAL,
        errorMessage:
          failure instanceof Error ? failure.message : String(failure),
      };
    }
  }

  /**
   * Reads an override in whatever transaction is right for the caller.
   *
   * Row-level security decides which override rows exist, so *which*
   * transaction is open is not an implementation detail — it is the answer.
   * Three cases, and none of them asks the caller to remember anything:
   *
   * - **Already in one.** Join it. A flag read inside the transaction that is
   *   about to act on the result sees the same tenant that transaction does.
   * - **A request, but no transaction yet.** Open the request's own. This is
   *   what lets a handler ask for a flag before it has opened anything and
   *   still get its own tenant's answer, rather than silently getting the
   *   global default because the policy saw no tenant.
   * - **Neither** — a worker handling a job for a tenant it names explicitly.
   *   A system transaction, where `worker_user` reads through the policy that
   *   names its role. `app_user` deliberately gets nothing here: it has no
   *   such policy, so an API process outside a request cannot read any
   *   tenant's overrides at all.
   */
  /**
   * Which organization this evaluation is for.
   *
   * In order, and each step is there because the one before it does not cover
   * the case:
   *
   * 1. **Named in the evaluation context.** A worker handling one tenant's job
   *    knows, and there is no request or tenant transaction to read it from.
   * 2. **The open transaction.** The same source the outbox and quota
   *    repositories read their tenant from, and the one that agrees with the
   *    policy that will bound the query.
   * 3. **The ambient request.** What lets a handler ask for a flag before it
   *    has opened any transaction and still get its own tenant's answer.
   *
   * `undefined` means no tenant, and then no override is read at all: an API
   * process outside a request must not be handed some organization's answer by
   * accident.
   */
  private organizationFor(context: EvaluationContext): string | undefined {
    const named = context[ORG_TARGETING_KEY];

    if (typeof named === 'string' && named.length > 0) {
      return named;
    }

    const open = this.db.currentTransactionContext();

    if (open?.kind === 'org') {
      return open.orgId;
    }

    const request = currentRequestContext();

    return request?.tenant.kind === 'org' ? request.tenant.orgId : undefined;
  }

  private async overrideFor(orgId: string, flagKey: string) {
    if (this.db.currentTransactionContext() !== undefined) {
      return this.flags.overrideFor(orgId, flagKey);
    }

    if (currentRequestContext()) {
      return this.db.withRequestTransaction(() =>
        this.flags.overrideFor(orgId, flagKey),
      );
    }

    return this.db.withSystemTransaction(() =>
      this.flags.overrideFor(orgId, flagKey),
    );
  }
}

/** A stored value, if it is the type the caller asked for. */
function typed<T>(
  stored: unknown,
  defaultValue: T,
  matches: (value: unknown) => value is T,
  reason: string,
): ResolutionDetails<T> {
  if (matches(stored)) {
    return { value: stored, reason };
  }

  // A flag whose type was changed under a caller that still asks for the old
  // one. Reported rather than coerced: `Boolean("false")` is `true`, and a
  // kill switch that inverts itself on a typo is worse than one that does
  // nothing.
  return {
    value: defaultValue,
    reason: StandardResolutionReasons.ERROR,
    errorCode: ErrorCode.TYPE_MISMATCH,
    errorMessage: `The stored value is ${describe(stored)}, which is not what the caller asked for.`,
  };
}

function describe(value: unknown): string {
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObjectOrArray<T extends JsonValue>(value: unknown): value is T {
  return typeof value === 'object' && value !== null;
}
