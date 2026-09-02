import { Module } from '@nestjs/common';

import { AuthService } from './auth.service';

/**
 * better-auth is mounted on the Fastify instance rather than routed by Nest
 * (ADR-0002), so this module exists to build and share the instance, not to
 * declare controllers.
 */
@Module({
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
