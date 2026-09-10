import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Principal } from '@workspace/core-server-authz';
import { AppConfig } from '@workspace/core-server-core';
import {
  Database,
  ErasureRequestRepository,
} from '@workspace/core-server-data-access-db';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface ErasureSchedule {
  readonly requestedAt: Date;
  readonly erasesAt: Date;
  readonly graceDays: number;
}

/**
 * A person asking to be forgotten.
 *
 * The request path only ever writes a timestamp. Everything that deletes runs
 * on the worker, as `erasure_role`, on its own connection — nothing reachable
 * from an HTTP handler can remove a person or edit an audit record, which is
 * what makes the grace window a guarantee rather than a convention.
 *
 * **The subject asks for themselves.** There is no administrative route here:
 * erasing somebody else is a decision about who may, and it needs an answer
 * about organizations and their members that this phase does not have. What
 * the regulation is actually about is the person asking, and that is what
 * exists.
 */
@Injectable()
export class PrivacyService {
  private readonly logger = new Logger(PrivacyService.name);
  private readonly db: Database;
  private readonly requests: ErasureRequestRepository;
  private readonly config: AppConfig;

  constructor(
    @Inject(Database) db: Database,
    @Inject(ErasureRequestRepository) requests: ErasureRequestRepository,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.db = db;
    this.requests = requests;
    this.config = config;
  }

  async requestErasure(principal: Principal): Promise<ErasureSchedule> {
    const requestedAt = await this.db.withRequestTransaction(() =>
      this.requests.request(principal.id),
    );

    // At log level, deliberately: this is the start of something
    // irreversible, and the line is what an operator has to be able to find
    // when somebody asks what happened to their account.
    this.logger.log(
      `${principal.id} asked to be erased at ${requestedAt.toISOString()}.`,
    );

    return this.scheduleFrom(requestedAt);
  }

  /** Takes it back, while there is still something to take back. */
  async cancelErasure(principal: Principal): Promise<boolean> {
    const cancelled = await this.db.withRequestTransaction(() =>
      this.requests.cancel(principal.id),
    );

    if (cancelled) {
      this.logger.log(`${principal.id} cancelled their erasure request.`);
    }

    return cancelled;
  }

  async statusOf(principal: Principal): Promise<ErasureSchedule | null> {
    const { requestedAt } = await this.db.withRequestTransaction(() =>
      this.requests.statusOf(principal.id),
    );

    return requestedAt === null ? null : this.scheduleFrom(requestedAt);
  }

  /**
   * When the request becomes real.
   *
   * Computed from the configured window rather than stored, so changing the
   * window changes every pending request — which is the honest behaviour: the
   * job reads the same setting, and a stored date would tell people something
   * the job would not honour.
   */
  private scheduleFrom(requestedAt: Date): ErasureSchedule {
    const graceDays = this.config.get('ERASURE_GRACE_DAYS');

    return {
      requestedAt,
      erasesAt: new Date(requestedAt.getTime() + graceDays * DAY_MS),
      graceDays,
    };
  }
}
