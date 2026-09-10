export {
  ENVELOPE_SCHEMA_VERSION,
  EnvelopeError,
  FIRST_ATTEMPT,
  createEnvelope,
  jobEnvelopeSchema,
  parseEnvelope,
  type EnvelopedJob,
  type JobEnvelope,
} from './lib/job-envelope.js';
export { EvictionPolicyError, assertNoEviction } from './lib/redis-policy.js';
export { classifyFailure, type FailureClass } from './lib/retry-policy.js';
export { QueueModule } from './lib/queue.module.js';
export { QUEUE_CONNECTION } from './lib/queue.tokens.js';
export {
  QueueService,
  type EnqueueContext,
  type EnqueueOptions,
  type JobDefinition,
  type JobHandler,
  type Schedule,
} from './lib/queue.service.js';
