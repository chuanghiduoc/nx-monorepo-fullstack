import { Module } from '@nestjs/common';

import { AuthService } from './auth.service.js';

/**
 * better-auth is mounted on the Fastify instance rather than routed by Nest
 *, so this module exists to build and share the instance, not to
 * declare controllers.
 */
@Module({
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
