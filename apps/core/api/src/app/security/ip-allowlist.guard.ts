import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { currentRequestContext, isAddressAllowed } from '@workspace/core-server-core';
import { OrgSettingsRepository } from '@workspace/core-server-data-access-db';
import type { FastifyRequest } from 'fastify';

const ALLOWLIST_KEY = 'security.ipAllowlist';

/**
 * Refuses a request from an address the organization has not admitted.
 *
 * The address is `request.ip`, which Fastify resolves from `X-Forwarded-For`
 * only for the hops named in `TRUSTED_PROXIES`. Reading the header directly
 * would let any caller name its own address, and this guard would then admit
 * everyone while appearing to work.
 *
 * A request with no organization is not checked: there is no allowlist to
 * check it against, and the routes that matter are refused earlier for want
 * of a tenant.
 */
@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(IpAllowlistGuard.name);
  private readonly settings: OrgSettingsRepository;

  constructor(@Inject(OrgSettingsRepository) settings: OrgSettingsRepository) {
    this.settings = settings;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requestContext = currentRequestContext();

    if (requestContext?.tenant.kind !== 'org') {
      return true;
    }

    const configured = await this.settings.find(ALLOWLIST_KEY);
    const allowlist = configured?.value ?? [];

    if (allowlist.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (isAddressAllowed(request.ip, allowlist)) {
      return true;
    }

    // The address is in the log, where an administrator can see who was
    // refused; the client is told only that it may not.
    this.logger.warn(
      `Refused ${request.ip} for organization ${requestContext.tenant.orgId}: not in the allowlist`,
    );

    throw new ForbiddenException(
      'This organization does not accept requests from your network.',
    );
  }
}
