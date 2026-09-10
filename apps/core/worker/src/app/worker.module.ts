import { Module } from '@nestjs/common';

import {
  AppConfigModule,
  AppLoggerModule,
} from '@workspace/core-server-core';
import { DatabaseModule } from '@workspace/core-server-data-access-db';
import { FlagsModule } from '@workspace/core-server-flags';
import { QueueModule } from '@workspace/core-server-queue';
import { ObservabilityModule } from '@workspace/core-server-observability';
import { RealtimeModule } from '@workspace/core-server-realtime';
import { StorageModule } from '@workspace/core-server-storage';

import { HeartbeatService } from './health/heartbeat.service.js';
import { AuditConsumer } from './outbox/audit.consumer.js';
import { ErasureModule } from './erasure/erasure.module.js';
import { FileScanner } from './files/file-scanner.job.js';
import { WebhookDispatcher } from './webhooks/webhook.dispatcher.js';
import { WebhookSender } from './webhooks/webhook.sender.js';
import { OutboxRelay } from './outbox/outbox.relay.js';
import { JobRegistry } from './jobs/job-registry.js';
import { RetentionSweep } from './jobs/retention.job.js';

/**
 * The worker.
 *
 * It imports no HTTP feature and mounts no controller: a worker that can serve
 * a request is an API with a confusing name, and the two would then have to be
 * deployed, scaled and secured as one thing.
 *
 * `forWorker` validates the worker's own environment rather than the API's, so
 * this process is never handed a session signing key it has no use for — and
 * so a missing variable it *does* need stops it at boot with the name of the
 * variable.
 *
 * `WORKER_DATABASE_URL` rather than `DATABASE_URL`, because the worker
 * connects as a role of its own. One variable shared between the two processes
 * would mean both connect as whichever role the shell exported, and the one
 * that is wrong is the one with more rights than it needs.
 */
@Module({
  imports: [
    AppConfigModule.forWorker(),
    // The worker traces too, or `api → queue → worker` is a trace that stops
    // at the queue. It serves no metrics: giving it an HTTP surface to do so
    // would undo the reason it has none.
    ObservabilityModule.forRoot({ serviceName: 'core-worker' }),
    AppLoggerModule,
    DatabaseModule.forRoot('WORKER_DATABASE_URL', 'WORKER_DATABASE_POOL_MAX'),
    QueueModule.forRoot(),
    // A job evaluates flags for the tenant it is acting for, named
    // explicitly: it runs in a system transaction, and `worker_user` reads
    // overrides through a policy that names its role.
    FlagsModule,
    // Its own connection, as its own role, opened for the minute the job runs.
    ErasureModule,
    // The worker reads objects to check them, so it needs the same store the
    // API signs uploads into.
    StorageModule,
    // A scan's verdict is the clearest thing a browser wants told, and the
    // worker is where it is decided. Publishing only — the bus creates its
    // subscribing connection on the first listener, and this process has none.
    RealtimeModule.forRoot(),
  ],
  providers: [
    RetentionSweep,
    JobRegistry,
    HeartbeatService,
    OutboxRelay,
    AuditConsumer,
    WebhookDispatcher,
    WebhookSender,
    FileScanner,
  ],
})
export class WorkerModule {}
