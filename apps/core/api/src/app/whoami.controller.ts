import { Controller, Get, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { currentRequestContext } from '@workspace/core-server-core';

/**
 * Reports the identity the request resolved to.
 *
 * It exists so the resolution can be tested end to end rather than only in a
 * unit test with a fabricated request: the interesting failures — a key
 * falling back to a cookie, a context that does not survive into the handler —
 * only appear over a real connection.
 */
@Controller()
export class WhoamiController {
  @Get('whoami')
  whoami(@Req() request: FastifyRequest) {
    const context = currentRequestContext();

    return {
      principal: context?.principal ?? null,
      tenant: context?.tenant ?? null,
      // The address every per-caller decision uses: rate limiting, the
      // per-organization IP allowlist, and what a log line records. Reported
      // here so the forwarding rules can be tested rather than assumed.
      ip: request.ip,
    };
  }
}
