import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';

const DEFAULT_LEASE_MS = 30_000;

const STATE = {
  processing: 'PROCESSING',
  completed: 'COMPLETED',
  failed: 'FAILED',
} as const;

export type IdempotencyScopeType = 'ORG' | 'USER' | 'API_KEY' | 'SYSTEM';

export interface ClaimInput {
  scopeType: IdempotencyScopeType | string;
  scopeId: string;
  route: string;
  key: string;
  requestHash: string;
  /** Negative values are useful in tests to simulate an expired lease. */
  leaseMs?: number;
}

export interface CompleteInput {
  scopeType: IdempotencyScopeType | string;
  scopeId: string;
  route: string;
  key: string;
  fenceToken: number;
  responseStatus: number;
  responseBody: unknown;
}

export type ClaimResult =
  /** The caller owns the key and must do the work. */
  | { outcome: 'claimed'; fenceToken: number }
  /** Someone else is doing the work right now. */
  | { outcome: 'in-progress' }
  /** The work is done; return the stored response instead of repeating it. */
  | { outcome: 'replay'; responseStatus: number; responseBody: unknown }
  /** Same key, different request — the client made a mistake. */
  | { outcome: 'request-mismatch' };

/**
 * Durable idempotency.
 *
 * The unique constraint is what actually prevents duplicate work: two requests
 * racing on the same key both try to insert, and the database lets exactly one
 * through. Redis can accelerate the lookup later, but it can never be the
 * source of truth — a restart would let a retried payment run twice.
 *
 * Expiry is a lease, not a timeout. It permits a recovery attempt; it does not
 * prove the first attempt died. The fence token is what makes that safe: a
 * zombie attempt waking up with an old token cannot overwrite the result of the
 * attempt that legitimately owns the key now.
 */
@Injectable()
export class IdempotencyStore {
  private readonly prisma: PrismaService;

  // Declared with @Inject rather than relying on emitted parameter metadata:
  // the constructor takes a plain parameter (parameter properties are not
  // supported by the type stripper the tests run under), so Nest has nothing
  // to infer from.
  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const leaseUntil = new Date(Date.now() + (input.leaseMs ?? DEFAULT_LEASE_MS));
    const where = this.identity(input);

    const existing = await this.prisma.idempotencyRecord.findUnique({ where });

    if (!existing) {
      try {
        const created = await this.prisma.idempotencyRecord.create({
          data: {
            ...where.scopeType_scopeId_route_idempotencyKey,
            requestHash: input.requestHash,
            state: STATE.processing,
            leaseUntil,
          },
        });

        return { outcome: 'claimed', fenceToken: created.fenceToken };
      } catch {
        // Another request inserted between the read and the write; fall through
        // and treat it as if we had seen it in the first place.
        return this.claim({ ...input, leaseMs: input.leaseMs });
      }
    }

    if (existing.requestHash !== input.requestHash) {
      return { outcome: 'request-mismatch' };
    }

    if (existing.state === STATE.completed) {
      return {
        outcome: 'replay',
        responseStatus: existing.responseStatus ?? 200,
        responseBody: existing.responseBody,
      };
    }

    if (existing.leaseUntil > new Date()) {
      return { outcome: 'in-progress' };
    }

    // The lease expired. Take it over, but only if nobody else did first — the
    // conditional update is what makes this safe under concurrency.
    const reclaimed = await this.prisma.idempotencyRecord.updateMany({
      where: { id: existing.id, fenceToken: existing.fenceToken },
      data: {
        fenceToken: existing.fenceToken + 1,
        leaseUntil,
        state: STATE.processing,
        startedAt: new Date(),
      },
    });

    if (reclaimed.count === 0) {
      return { outcome: 'in-progress' };
    }

    return { outcome: 'claimed', fenceToken: existing.fenceToken + 1 };
  }

  async complete(input: CompleteInput): Promise<void> {
    const where = this.identity(input);
    const record = await this.prisma.idempotencyRecord.findUnique({ where });

    const updated = await this.prisma.idempotencyRecord.updateMany({
      where: { id: record?.id ?? '', fenceToken: input.fenceToken },
      data: {
        state: STATE.completed,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody as never,
        completedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      throw new Error(
        `Idempotency fence token ${input.fenceToken} is stale; another attempt owns this key`,
      );
    }
  }

  async fail(input: Omit<CompleteInput, 'responseBody'>): Promise<void> {
    const where = this.identity(input);
    const record = await this.prisma.idempotencyRecord.findUnique({ where });

    await this.prisma.idempotencyRecord.updateMany({
      where: { id: record?.id ?? '', fenceToken: input.fenceToken },
      data: {
        state: STATE.failed,
        responseStatus: input.responseStatus,
        completedAt: new Date(),
      },
    });
  }

  private identity(input: {
    scopeType: string;
    scopeId: string;
    route: string;
    key: string;
  }) {
    return {
      scopeType_scopeId_route_idempotencyKey: {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        route: input.route,
        idempotencyKey: input.key,
      },
    };
  }
}
