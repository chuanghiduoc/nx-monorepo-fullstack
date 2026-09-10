import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import {
  Database,
  QuotaRepository,
  RetentionRepository,
  SWEEP_BATCH,
  WebhookRepository,
} from '@workspace/core-server-data-access-db';
import { WorkerConfig } from '@workspace/core-server-core';
import type { JobDefinition } from '@workspace/core-server-queue';

/**
 * How many batches each table gets before the run stops and waits for the next
 * tick. Four tables, so a run does at most four times this many.
 *
 * A backlog is cleared over several runs rather than in one transaction-heavy
 * burst. Without a bound, the first run after a long outage would sweep an
 * unbounded number of rows and hold the worker for as long as that took.
 */
const MAX_BATCHES_PER_TABLE = 20;

const MINUTE_MS = 60 * 1_000;

/**
 * The recurring sweep has no payload: what to delete is decided by the clock
 * and by the rows, not by whoever asked. It is still a schema, because the
 * envelope contract is that every job has one.
 */
export const retentionSweep: JobDefinition<Record<string, never>> = {
  queue: 'retention',
  name: 'sweep',
  payload: z.object({}).strict(),
};

export interface SweepReport {
  readonly sessions: number;
  readonly verifications: number;
  readonly idempotencyRecords: number;
  readonly expiredReservations: number;
  readonly webhookDeliveries: number;
}

/**
 * Settles what has expired.
 *
 * Three tables of rows the system wrote for itself — a session past its
 * expiry, a verification token past its expiry, and an idempotency record
 * nobody can replay any more — and one that is not a delete at all: a quota
 * reservation nobody committed or released, whose units have to go back to the
 * counter they were taken from.
 *
 * The reservations belong here rather than on the relay, unlike the dedup
 * table: their volume is bounded by how many long jobs start, not by how fast
 * the outbox delivers, so an hourly job keeps up. It also keeps the worker's
 * connection arithmetic unchanged — this sweep already runs at concurrency
 * one, and this is one more statement inside it.
 *
 * A consumer's record of an event is *not* here. It is written at the rate the
 * relay delivers — a hundred a second — and an hourly job with this budget
 * clears five and a half, so it belongs where it is produced. None of them belongs to a tenant, so the work
 * runs in a system transaction and reaches the tables through grants rather
 * than through a policy.
 *
 * Each batch is its own transaction. One transaction around the whole sweep
 * would hold locks on the busiest tables in the schema for as long as the
 * backlog took to clear.
 */
@Injectable()
export class RetentionSweep {
  private readonly logger = new Logger(RetentionSweep.name);
  private readonly db: Database;
  private readonly retention: RetentionRepository;
  private readonly quota: QuotaRepository;
  private readonly webhooks: WebhookRepository;
  private readonly config: WorkerConfig;

  constructor(
    @Inject(Database) db: Database,
    @Inject(RetentionRepository) retention: RetentionRepository,
    @Inject(QuotaRepository) quota: QuotaRepository,
    @Inject(WebhookRepository) webhooks: WebhookRepository,
    @Inject(WorkerConfig) config: WorkerConfig,
  ) {
    this.db = db;
    this.retention = retention;
    this.quota = quota;
    this.webhooks = webhooks;
    this.config = config;
  }

  /** How often this runs, and therefore part of the schedule's identity. */
  get intervalMs(): number {
    return this.config.get('RETENTION_SWEEP_INTERVAL_MINUTES') * MINUTE_MS;
  }

  async run(): Promise<SweepReport> {
    const hours = this.config.get('IDEMPOTENCY_RETENTION_HOURS');

    const report: SweepReport = {
      sessions: await this.repeat(() =>
        this.retention.sweepExpiredSessions(SWEEP_BATCH),
      ),
      verifications: await this.repeat(() =>
        this.retention.sweepExpiredVerifications(SWEEP_BATCH),
      ),
      idempotencyRecords: await this.repeat(() =>
        this.retention.sweepIdempotencyRecords(hours, SWEEP_BATCH),
      ),
      expiredReservations: await this.repeat(() =>
        this.quota.sweepExpired(SWEEP_BATCH),
      ),
      webhookDeliveries: await this.repeat(() =>
        this.webhooks.sweepDeliveries(
          this.config.get('WEBHOOK_DELIVERY_RETENTION_HOURS'),
          SWEEP_BATCH,
        ),
      ),
    };

    const total =
      report.sessions +
      report.verifications +
      report.idempotencyRecords +
      report.expiredReservations +
      report.webhookDeliveries;

    if (total > 0) {
      this.logger.log(
        `Swept ${report.sessions} sessions, ${report.verifications} verification tokens ` +
          `${report.idempotencyRecords} idempotency records and ` +
          `${report.webhookDeliveries} webhook delivery records; returned the units of ` +
          `${report.expiredReservations} expired quota reservations.`,
      );
    }

    return report;
  }

  /**
   * Runs one bounded statement at a time until there is nothing left to take.
   *
   * The stopping condition is an empty run rather than a short one, because a
   * sweep may issue more than one statement and "short" would then mean
   * comparing against a total nobody declared. Empty also covers the case
   * where another replica holds the rest under SKIP LOCKED: the next tick
   * finds whatever is left.
   */
  private async repeat(batch: () => Promise<number>): Promise<number> {
    let swept = 0;

    for (let run = 0; run < MAX_BATCHES_PER_TABLE; run += 1) {
      const deleted = await this.db.withSystemTransaction(batch);
      swept += deleted;

      if (deleted === 0) {
        return swept;
      }
    }

    this.logger.warn(
      `The sweep stopped at ${MAX_BATCHES_PER_TABLE} batches with rows still to delete. ` +
        'If this repeats, the schedule is running less often than the rows arrive.',
    );

    return swept;
  }
}
