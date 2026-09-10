import { Module } from '@nestjs/common';

import { AiController } from './ai.controller.js';
import { RagService } from './rag.service.js';

/**
 * The assistant's routes.
 *
 * The model facade is not imported here: `AiModule.forRoot()` is global, so a
 * feature that asks a model depends on the one service it uses rather than on
 * the library that builds its provider.
 */
@Module({
  controllers: [AiController],
  providers: [RagService],
  exports: [RagService],
})
export class AiFeatureModule {}
