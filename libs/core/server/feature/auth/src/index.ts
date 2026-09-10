export { AuthModule } from './lib/auth.module.js';
export { AuthService, type Auth } from './lib/auth.service.js';
export { mountBetterAuth } from './lib/auth.handler.js';
export {
  API_KEY_HEADER,
  mountTenantContext,
  principalFromHeaders,
} from './lib/tenant-context.hook.js';
export {
  SCHEMA_GENERATION_TUNING,
  authOptionsFor,
  type AuthOptions,
  type AuthTuning,
} from './lib/auth.options.js';
export {
  ac,
  rolePermissions,
  roles,
  statements,
} from './lib/access-control.js';
