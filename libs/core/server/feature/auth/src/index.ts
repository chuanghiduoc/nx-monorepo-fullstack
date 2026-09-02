export { AuthModule } from './lib/auth.module.js';
export { AuthService, type Auth } from './lib/auth.service.js';
export { mountBetterAuth } from './lib/auth.handler.js';
export {
  API_KEY_HEADER,
  mountTenantContext,
} from './lib/tenant-context.hook.js';
export { authOptions } from './lib/auth.options.js';
export { ac, roles, statements } from './lib/access-control.js';
