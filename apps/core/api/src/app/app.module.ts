import { Module } from '@nestjs/common';
import { AppConfigModule, AppLoggerModule } from '@workspace/core-server-core';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  // Configuration is validated here, so an invalid environment fails the boot
  // rather than the first request that needs a value.
  imports: [AppConfigModule, AppLoggerModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
