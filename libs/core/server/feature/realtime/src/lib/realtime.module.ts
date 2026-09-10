import { Module } from '@nestjs/common';

import { RealtimeController } from './realtime.controller.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeStreams } from './realtime.streams.js';

/**
 * Both transports, over the one bus.
 *
 * The bus itself is not imported here: `RealtimeModule.forRoot()` in the
 * platform library is global, so a feature that publishes depends on the
 * service rather than on the library that builds its connection.
 */
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeStreams, RealtimeGateway],
  exports: [RealtimeStreams],
})
export class RealtimeFeatureModule {}
