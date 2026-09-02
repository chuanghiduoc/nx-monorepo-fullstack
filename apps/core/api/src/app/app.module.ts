import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  AppLoggerModule,
  AppThrottlerModule,
} from '@workspace/core-server-core';
import { DatabaseModule } from '@workspace/core-server-data-access-db';

import { AuthModule } from '@workspace/core-server-feature-auth';

import { APP_GUARD } from '@nestjs/core';

import { AppController } from './app.controller';
import { IpAllowlistGuard } from './security/ip-allowlist.guard';
import { WhoamiController } from './whoami.controller';
import { DemoItemsModule } from './demo-items/demo-items.module';
import { AppService } from './app.service';

@Module({
  // Configuration is validated here, so an invalid environment fails the boot
  // rather than the first request that needs a value.
  imports: [
    AppConfigModule.forRoot(),
    AppLoggerModule,
    AppThrottlerModule,
    DatabaseModule,
    AuthModule,
    DemoItemsModule,
  ],
  controllers: [AppController, WhoamiController],
  providers: [
    AppService,
    // Global: an organization that restricts its networks means every route,
    // not the ones a developer remembered to annotate.
    { provide: APP_GUARD, useClass: IpAllowlistGuard },
  ],
})
export class AppModule {}
