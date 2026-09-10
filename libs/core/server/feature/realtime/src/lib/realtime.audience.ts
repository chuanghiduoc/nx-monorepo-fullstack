import { ForbiddenException } from '@nestjs/common';
import type { Principal } from '@workspace/core-server-authz';
import type { RealtimeAudience } from '@workspace/core-server-realtime';

/**
 * The stream a principal is entitled to, and no other.
 *
 * The same split the database makes: someone acting inside an organization
 * shares that organization's stream, and someone acting alone has one of their
 * own. Derived here from the resolved principal rather than taken from the
 * request, because a client that could name its room could name someone
 * else's — and no check afterwards recovers from that.
 */
export function audienceFor(principal: Principal): RealtimeAudience {
  switch (principal.type) {
    case 'apiKey':
      return principal.orgId
        ? { kind: 'org', orgId: principal.orgId }
        : { kind: 'user', userId: principal.issuerId };
    case 'user':
      return principal.orgId
        ? { kind: 'org', orgId: principal.orgId }
        : { kind: 'user', userId: principal.id };
    default:
      // A relay or a scheduler has no stream to watch: it publishes, it does
      // not subscribe. Reaching here means something opened a connection as a
      // system principal, which is a bug rather than a permission problem.
      throw new ForbiddenException(
        'A system principal has no realtime stream to subscribe to.',
      );
  }
}
