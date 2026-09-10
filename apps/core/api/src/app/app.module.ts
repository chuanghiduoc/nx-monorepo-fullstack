import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  AppLoggerModule,
  AppThrottlerModule,
} from '@workspace/core-server-core';
import { DatabaseModule } from '@workspace/core-server-data-access-db';
import { FlagsModule } from '@workspace/core-server-flags';
import { QueueModule } from '@workspace/core-server-queue';
import { AiModule } from '@workspace/core-server-ai';
import { ObservabilityModule } from '@workspace/core-server-observability';
import { AiFeatureModule } from '@workspace/core-server-feature-ai';
import { RealtimeModule } from '@workspace/core-server-realtime';
import { RealtimeFeatureModule } from '@workspace/core-server-feature-realtime';
import { PrivacyModule } from '@workspace/core-server-feature-privacy';

import { AuthzModule } from '@workspace/core-server-authz';
import {
  AuthModule,
  rolePermissions,
} from '@workspace/core-server-feature-auth';
import { NotesModule } from '@workspace/core-server-feature-notes';

import { APP_GUARD } from '@nestjs/core';

import { AppController } from './app.controller';
import { MetricsCollector } from './metrics.collector';
import { MetricsController } from './metrics.controller';
import { IpAllowlistGuard } from './security/ip-allowlist.guard';
import { WhoamiController } from './whoami.controller';
import { DemoItemsModule } from './demo-items/demo-items.module';
import { AppService } from './app.service';

@Module({
  // Configuration is validated here, so an invalid environment fails the boot
  // rather than the first request that needs a value.
  imports: [
    AppConfigModule.forRoot(),
    // The tracer and the metric registry, global like the queue and the bus.
    // After the configuration module, because the collector's address is a
    // validated variable rather than something read from the environment.
    ObservabilityModule.forRoot({ serviceName: 'core-api' }),
    AppLoggerModule,
    AppThrottlerModule,
    // Named here because the worker connects with a different variable, as a
    // role with fewer rights.
    DatabaseModule.forRoot('DATABASE_URL', 'DATABASE_POOL_MAX'),
    AuthModule,
    // The role definitions live with authentication, which is where an
    // organization's roles are administered; the facade evaluates them.
    AuthzModule.forRoot(rolePermissions),
    // Flags come after the database module, which they read through; they
    // deliberately do not import it themselves, because a second import
    // would build a second client with a second connection pool.
    FlagsModule,
    // The API produces no jobs — writes go to the outbox and the worker
    // relays them — so this is here for the scrape: queue depth lives in
    // Redis, and the process that would otherwise read it has no HTTP surface
    // by design. It also brings the no-eviction check to a process that
    // already depends on that instance not evicting, for the rate limiter and
    // the throttler.
    QueueModule.forRoot(),
    // The fan-out connection, global like the queue's, and the two transports
    // that ride on it.
    RealtimeModule.forRoot(),
    RealtimeFeatureModule,
    // The model facade, global like the queue and the bus, and the routes that
    // use it. A deployment with no provider still starts: the module logs one
    // line and every call is refused with the variable's name.
    AiModule.forRoot(),
    AiFeatureModule,
    NotesModule,
    // The person's own erasure request, and where an organization's events go.
    PrivacyModule,
    DemoItemsModule,
  ],
  controllers: [AppController, WhoamiController, MetricsController],
  providers: [
    AppService,
    MetricsCollector,
    // Global: an organization that restricts its networks means every route,
    // not the ones a developer remembered to annotate.
    { provide: APP_GUARD, useClass: IpAllowlistGuard },
  ],
})
export class AppModule {}
