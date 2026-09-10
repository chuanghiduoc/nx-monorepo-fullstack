import { Module } from '@nestjs/common';

import { ErasureRequestRepository } from '@workspace/core-server-data-access-db';
import { StorageModule } from '@workspace/core-server-storage';

import { FilesController } from './files.controller.js';
import { LocalStorageController } from './local-storage.controller.js';
import { FilesService } from './files.service.js';
import { PrivacyController } from './privacy.controller.js';
import { PrivacyService } from './privacy.service.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * The routes a person and an organization use to control their own data.
 *
 * Two subjects that look unrelated and are not: both are about where data goes
 * and when it stops existing, and both are request-side halves of work the
 * worker actually does. Neither can delete anything itself — the erasure runs
 * as `erasure_role` on the worker, and a webhook endpoint's secret is
 * unreadable to every role a request can use.
 */
@Module({
  imports: [StorageModule],
  controllers: [
    PrivacyController,
    WebhooksController,
    FilesController,
    // Where a `local` driver's signed URLs point. Mounted unconditionally and
    // refusing every request when the driver is S3: a controller registered
    // from a config value is a route that exists in one environment and not
    // another, which is how a test proves nothing about production.
    LocalStorageController,
  ],
  providers: [
    PrivacyService,
    WebhooksService,
    FilesService,
    ErasureRequestRepository,
  ],
})
export class PrivacyModule {}
