// The root Prisma client is exported for exactly one caller: the erasure job,
// which opens a connection as its own role for the minute it runs and closes
// it again. Everything else goes through `Database` and the repositories —
// `guardRootClient` refuses a query on it inside a transaction, so the export
// widens what can be *constructed*, not what can be queried.
export { PrismaService } from './lib/prisma.service.js';
export {
  ErasureRepository,
  type ErasureOutcome,
} from './lib/erasure/erasure.repository.js';
export {
  ErasureRequestRepository,
  type ErasureStatus,
} from './lib/erasure/erasure-request.repository.js';
export {
  AuditRepository,
  type AuditEntry,
} from './lib/audit/audit.repository.js';
export { DatabaseModule } from './lib/database.module.js';
export {
  FILE_STATUSES,
  FileRepository,
  type CreateFile,
  type FileRecord,
  type FileStatus,
  type ScanVerdict,
} from './lib/files/file.repository.js';
export {
  WebhookRepository,
  type AttemptRecord,
  type CreateEndpoint,
  type WebhookEndpointView,
  type WebhookTarget,
} from './lib/webhooks/webhook.repository.js';
export {
  FlagRepository,
  type FlagRow,
} from './lib/flags/flag.repository.js';
export { DATABASE_URL_VARIABLE } from './lib/database.tokens.js';
export {
  RetentionRepository,
  SWEEP_BATCH,
} from './lib/retention/retention.repository.js';
export {
  MAX_PAYLOAD_BYTES,
  OutboxRepository,
  type AppendEvent,
  type ClaimedEvent,
  type FailedEvent,
  type KilledEvent,
  type OutboxStatus,
  type ReplayOutcome,
} from './lib/outbox/outbox.repository.js';
export {
  AiRepository,
  EMBEDDING_DIMENSIONS,
  type AiDocumentRecord,
  type ChunkMatch,
  type NewChunk,
} from './lib/ai/ai.repository.js';
export { ProcessedEventRepository } from './lib/outbox/processed-event.repository.js';
export {
  QuotaRepository,
  type ConsumeRequest,
  type RecordRequest,
  type ReserveRequest,
} from './lib/quota/quota.repository.js';
export {
  LIFETIME_WINDOW_START,
  windowStart,
  type QuotaWindow,
} from './lib/quota/window.js';
export {
  AuthDatabaseProvider,
  type AuthDatabase,
} from './lib/auth/auth-database.js';
export {
  Database,
  type IsolationLevel,
  type TransactionOptions,
} from './lib/transaction/database.js';
export {
  IdempotencyStore,
  type ClaimInput,
  type ClaimResult,
  type CompleteInput,
  type IdempotencyScopeType,
} from './lib/idempotency.store.js';
export {
  OrgSettingsRepository,
  type StoredSetting,
} from './lib/org-settings/org-settings.repository.js';
export {
  NoteRepository,
  type CreateNoteInput,
  type ListNotesInput,
  type Note,
  type NotePosition,
  type UpdateNoteInput,
} from './lib/notes/note.repository.js';
export { NoTenantContextError } from './lib/tenancy/tenant-guard.js';
export {
  DemoItemRepository,
  type CreateDemoItemInput,
  type DemoItem,
  type DemoItemPosition,
  type ListDemoItemsInput,
} from './lib/demo-items/demo-item.repository.js';
