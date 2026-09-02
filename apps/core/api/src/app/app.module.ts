import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  AppLoggerModule,
  AppThrottlerModule,
} from '@workspace/core-server-core';
import { DatabaseModule } from '@workspace/core-server-data-access-db';

import { AuthModule } from '@workspace/core-server-feature-auth';

import { AppController } from './app.controller';
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
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
