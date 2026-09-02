import { Module } from '@nestjs/common';

import { DemoItemsController } from './demo-items.controller';
import { DemoItemsService } from './demo-items.service';

// Database, repositories and the idempotency store come from the global
// DatabaseModule (imported once in AppModule).
@Module({
  controllers: [DemoItemsController],
  providers: [DemoItemsService],
})
export class DemoItemsModule {}
