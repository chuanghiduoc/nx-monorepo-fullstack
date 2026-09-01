import { Module } from '@nestjs/common';
import {
  IdempotencyStore,
  PrismaService,
} from '@workspace/core-server-data-access-db';

import { DemoItemsController } from './demo-items.controller';
import { DemoItemsService } from './demo-items.service';

@Module({
  controllers: [DemoItemsController],
  providers: [DemoItemsService, PrismaService, IdempotencyStore],
  exports: [IdempotencyStore],
})
export class DemoItemsModule {}
