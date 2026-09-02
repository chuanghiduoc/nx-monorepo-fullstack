// The root Prisma client (PrismaService) is deliberately not exported: work
// goes through Database and the repositories (spec §6.5).
export { DatabaseModule } from './lib/database.module.js';
export {
  Database,
  type IsolationLevel,
  type TransactionOptions,
} from './lib/transaction/database.js';
export {
  SYSTEM_CONTEXT,
  type TenantContext,
  type TenantScopedContext,
} from './lib/transaction/tenant-context.js';
export {
  IdempotencyStore,
  type ClaimInput,
  type ClaimResult,
  type CompleteInput,
  type IdempotencyScopeType,
} from './lib/idempotency.store.js';
export {
  DemoItemRepository,
  type CreateDemoItemInput,
  type DemoItem,
  type DemoItemPosition,
  type ListDemoItemsInput,
} from './lib/demo-items/demo-item.repository.js';
