// The root Prisma client (PrismaService) is deliberately not exported: work
// goes through Database and the repositories.
export { DatabaseModule } from './lib/database.module.js';
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
export { NoTenantContextError } from './lib/tenancy/tenant-guard.js';
export {
  DemoItemRepository,
  type CreateDemoItemInput,
  type DemoItem,
  type DemoItemPosition,
  type ListDemoItemsInput,
} from './lib/demo-items/demo-item.repository.js';
