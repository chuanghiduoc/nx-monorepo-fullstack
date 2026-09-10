export { AiFeatureModule } from './lib/ai-feature.module.js';
export { AiController } from './lib/ai.controller.js';
export {
  AiDocumentDto,
  AiDocumentListDto,
  AskQueryDto,
  IngestDocumentDto,
} from './lib/ai.dto.js';
export {
  PASSAGE_CHARACTERS,
  PASSAGE_OVERLAP,
  intoPassages,
} from './lib/chunking.js';
export {
  RagService,
  type Answer,
  type Citation,
  type Retrieved,
} from './lib/rag.service.js';
