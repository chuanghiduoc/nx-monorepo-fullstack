import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { WorkerConfig } from '@workspace/core-server-core';
import { QueueService } from '@workspace/core-server-queue';

/**
 * The default location, when the deployment has not named one.
 *
 * Named after the process, because two workers started on one machine — the
 * ordinary case for `pnpm dev` with more than one replica — would otherwise
 * share a liveness file and each report the other as alive.
 */
function defaultHeartbeatFile(): string {
  return join(tmpdir(), `core-worker-heartbeat-${process.pid}`);
}

/**
 * Says that this replica is alive, in a way a container runtime can read.
 *
 * A worker has no HTTP surface — one added for a health endpoint would be an
 * API with a confusing name — so liveness is a file whose modification time
 * the image's health check reads. Nothing but the standard library is
 * involved, which matters because that check runs as a bare `node -e` inside
 * the image.
 *
 * The interval comes from the same configuration the health check reads, so
 * the two cannot drift apart the way two literals in two files would.
 *
 * The file is only touched after the queue has answered a `PING`. A worker
 * whose queue is unreachable is not doing its job, and a heartbeat that proved
 * only that the event loop was turning would report it as healthy for as long
 * as it sat there.
 *
 * It is per replica, deliberately. A scheduled job would run on one replica
 * for the whole deployment, which is the opposite of what liveness needs.
 */
@Injectable()
export class HeartbeatService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly queue: QueueService;
  private readonly file: string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private beating: Promise<void> | undefined;
  private stopped = false;

  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(WorkerConfig) config: WorkerConfig,
  ) {
    this.queue = queue;
    this.file = config.get('WORKER_HEARTBEAT_FILE') ?? defaultHeartbeatFile();
    this.intervalMs = config.get('WORKER_HEARTBEAT_INTERVAL_MS');
  }

  async onApplicationBootstrap(): Promise<void> {
    // Written once before the timer, so a container is healthy as soon as it
    // has finished starting rather than one interval later.
    await this.beat();

    this.timer = setInterval(() => {
      this.beating = this.beat();
    }, this.intervalMs);

    // Otherwise this timer alone would keep the process alive after everything
    // else had shut down.
    this.timer.unref();

    this.logger.log(
      `Reporting liveness to ${this.file} every ${this.intervalMs}ms.`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = true;

    // A beat already in flight outlives the timer, and the queue's connection
    // closes moments later. Waiting for it is the difference between a clean
    // stop and an error line about a connection that was closed on purpose.
    await this.beating;
    this.beating = undefined;
  }

  private async beat(): Promise<void> {
    try {
      await this.queue.ping();
      await writeFile(this.file, `${Date.now()}\n`, 'utf8');
    } catch (failure) {
      if (this.stopped) {
        // Shutting down. The connection going away is what was asked for.
        return;
      }

      // Not rethrown: the timer is the only caller, and a rejection there
      // would be an unhandled one. Letting the file go stale is the report.
      this.logger.error(
        `Could not record liveness: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }
}
