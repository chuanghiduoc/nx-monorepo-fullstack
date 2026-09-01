import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, tap, type Observable } from 'rxjs';

import { fingerprintRequest, normaliseRoute } from './request-fingerprint.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const RETRY_AFTER_SECONDS = 5;
const MAX_STORED_BODY_BYTES = 64 * 1024;

/** The subset of the store this interceptor needs; keeps the lib ORM-agnostic. */
export interface IdempotencyBackend {
  claim(input: {
    scopeType: string;
    scopeId: string;
    route: string;
    key: string;
    requestHash: string;
  }): Promise<
    | { outcome: 'claimed'; fenceToken: number }
    | { outcome: 'in-progress' }
    | { outcome: 'replay'; responseStatus: number; responseBody: unknown }
    | { outcome: 'request-mismatch' }
  >;
  complete(input: {
    scopeType: string;
    scopeId: string;
    route: string;
    key: string;
    fenceToken: number;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void>;
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
  private readonly store: IdempotencyBackend;

  constructor(store: IdempotencyBackend) {
    this.store = store;
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
      requestHash: fingerprintRequest(request.method, request.url, request.body),
    };

    const claim = await this.store.claim(identity);

    if (claim.outcome === 'request-mismatch') {
      throw new UnprocessableEntityException(
        'This idempotency key was used with a different request',
      );
    }

    if (claim.outcome === 'in-progress') {
      reply.header('retry-after', RETRY_AFTER_SECONDS);
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
      tap({
        next: async (body: unknown) => {
          const status = reply.statusCode;
          await this.store.complete({
            ...identity,
            fenceToken,
            responseStatus: status,
            responseBody: this.storable(body),
          });
        },
      }),
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

  private header(
    request: FastifyRequest,
    name: string,
  ): string | undefined {
    const value = request.headers[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
