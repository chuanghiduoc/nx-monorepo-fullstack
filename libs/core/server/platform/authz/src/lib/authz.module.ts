import { Module, type DynamicModule } from '@nestjs/common';

import { AuthzService, type RolePermissions } from './authz.service.js';

/**
 * Provides the authorization facade.
 *
 * The role definitions are passed in rather than imported: which verbs an
 * owner gets is a product decision, and a platform library that decided it
 * would have to be edited by every product built on the platform.
 */
@Module({})
export class AuthzModule {
  static forRoot(rolePermissions: RolePermissions): DynamicModule {
    return {
      module: AuthzModule,
      global: true,
      providers: [
        { provide: AuthzService, useValue: new AuthzService(rolePermissions) },
      ],
      exports: [AuthzService],
    };
  }
}
