export {
  ACTION_REGISTRY,
  parseAction,
  permissionStatements,
  type Action,
  type ParsedAction,
} from './lib/action-registry.js';
export {
  AuthzService,
  type AuthorizationContext,
  type Decision,
  type RolePermissions,
} from './lib/authz.service.js';
export {
  describePrincipal,
  type ApiKeyPrincipal,
  type Permissions,
  type Principal,
  type SystemPrincipal,
  type UserPrincipal,
} from './lib/principal.js';
