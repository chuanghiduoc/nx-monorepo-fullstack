import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  catchError,
  concatMap,
  from,
  map,
  throwError,
  type Observable,
} from 'rxjs';

import { fingerprintRequest, normaliseRoute } from './request-fingerprint.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const RETRY_AFTER_SECONDS = 5;
const MAX_STORED_BODY_BYTES = 64 * 1024;
const INTERNAL_ERROR_STATUS = 500;

interface IdempotencyIdentity {
  scopeType: string;
  scopeId: string;
  route: string;
  key: string;
}

/** The subset of the store this interceptor needs; keeps the lib ORM-agnostic. */
export interface IdempotencyBackend {
  claim(
    input: IdempotencyIdentity & { requestHash: string },
  ): Promise<
    | { outcome: 'claimed'; fenceToken: number }
    | { outcome: 'in-progress' }
    | { outcome: 'replay'; responseStatus: number; responseBody: unknown }
    | { outcome: 'request-mismatch' }
  >;
  complete(
    input: IdempotencyIdentity & {
      fenceToken: number;
      responseStatus: number;
      responseBody: unknown;
    },
  ): Promise<void>;
  /**
   * Releases the key after a failed attempt. Without it the record sits in
   * PROCESSING until the lease expires, and every retry in that window is
   * answered with 409 instead of being allowed to try again.
   */
  fail(
    input: IdempotencyIdentity & { fenceToken: number; responseStatus: number },
  ): Promise<void>;
}

interface IdempotentRequest extends FastifyRequest {
  /** Populated by the auth layer in Phase 3; anonymous callers scope by IP. */
  principal?: { type: string; id: string };
}

/**
 * Makes retries of a mutation safe.
 *
 * Only mutations carrying an `Idempotency-Key` are affected, so an endpoint
 * opts in by documenting the header rather than by wiring anything.
 *
 * Streaming responses are out of scope: replaying one would mean buffering it,
 * which defeats the reason it streams.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private readonly store: IdempotencyBackend;

  /**
   * Counts a conflict, if anything is counting.
   *
   * Optional and injected rather than imported: this library is below the one
   * that owns the registry, and a metric nobody is collecting must not be a
   * reason this interceptor cannot be constructed — the suites build it with
   * one argument.
   */
  private readonly onConflict: ((route: string) => void) | undefined;

  constructor(store: IdempotencyBackend, onConflict?: (route: string) => void) {
    this.store = store;
    this.onConflict = onConflict;
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<IdempotentRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    const key = this.header(request, IDEMPOTENCY_KEY_HEADER);
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(
      request.method.toUpperCase(),
    );

    if (!key || !isMutation) {
      return next.handle();
    }

    const identity = {
      ...this.scopeOf(request),
      route: normaliseRoute(request.method, request.url),
      key,
      requestHash: fingerprintRequest(
        request.method,
        request.url,
        request.body,
      ),
    };

    const claim = await this.store.claim(identity);

    if (claim.outcome === 'request-mismatch') {
      // A client reusing a key with a different body is a client that thinks
      // it is retrying and is not. Worth a number, because it is a bug in
      // somebody's integration and nothing else reports it.
      this.onConflict?.(routeTemplateOf(context));
      throw new UnprocessableEntityException(
        'This idempotency key was used with a different request',
      );
    }

    if (claim.outcome === 'in-progress') {
      reply.header('retry-after', RETRY_AFTER_SECONDS);
      this.onConflict?.(routeTemplateOf(context));
      throw new ConflictException(
        'A request with this idempotency key is still being processed',
      );
    }

    if (claim.outcome === 'replay') {
      reply.status(claim.responseStatus);
      return from([claim.responseBody]);
    }

    const { fenceToken } = claim;

    return next.handle().pipe(
      // concatMap, not tap: the response must not be sent until the record is
      // COMPLETED, otherwise an immediate retry races the commit and gets 409
      // instead of the stored reply. tap would also drop the promise, turning
      // any rejection into an unhandled rejection — which on Node 24 ends the
      // process.
      concatMap((body: unknown) =>
        from(
          this.store.complete({
            ...identity,
            fenceToken,
            responseStatus: reply.statusCode,
            responseBody: this.storable(body),
          }),
        ).pipe(
          catchError((error: unknown) => {
            // The work succeeded and the client is owed its answer. A stale
            // fence token means another attempt legitimately took the key over
            // (its lease had expired) — losing the stored copy is the correct
            // outcome, not a failed request.
            this.logger.warn(
              `Could not record the idempotent result for ${identity.route}: ${describe(error)}`,
            );
            return from([undefined]);
          }),
          map(() => body),
        ),
      ),
      catchError((error: unknown) =>
        from(
          this.store.fail({
            ...identity,
            fenceToken,
            responseStatus: statusOf(error),
          }),
        ).pipe(
          catchError((releaseError: unknown) => {
            this.logger.warn(
              `Could not release the idempotency key for ${identity.route}: ${describe(releaseError)}`,
            );
            return from([undefined]);
          }),
          // The original failure is what the client must see; releasing the
          // key is bookkeeping and never replaces it.
          concatMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  /**
   * Responses above the limit are not stored: a replay returns the status
   * without the body, and the client re-reads the resource. Storing megabytes
   * per key would turn the table into a cache nobody asked for.
   */
  private storable(body: unknown): unknown {
    const serialised = JSON.stringify(body ?? null);

    return serialised.length > MAX_STORED_BODY_BYTES ? null : body;
  }

  private scopeOf(request: IdempotentRequest): {
    scopeType: string;
    scopeId: string;
  } {
    if (request.principal) {
      return {
        scopeType: request.principal.type,
        scopeId: request.principal.id,
      };
    }

    // Anonymous callers still get isolation, just a coarser one.
    return { scopeType: 'SYSTEM', scopeId: request.ip };
  }

  private header(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}

function statusOf(error: unknown): number {
  const status = (error as { getStatus?: () => number })?.getStatus?.();

  return typeof status === 'number' ? status : INTERNAL_ERROR_STATUS;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The route template this request matched, for a metric label.
 *
 * The template and never the URL: a path with an id in it would be one time
 * series per id, which is how a metrics backend is destroyed by an application
 * that meant well.
 */
function routeTemplateOf(context: ExecutionContext): string {
  const request = context.switchToHttp().getRequest<{
    routeOptions?: { url?: string };
  }>();

  return request.routeOptions?.url ?? 'unmatched';
}
