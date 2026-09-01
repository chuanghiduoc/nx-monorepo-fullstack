import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { fromNodeHeaders } from 'better-auth/node';

import { auth } from './auth.config';

const AUTH_ROUTE = '/api/auth/*';
const METHODS = ['GET', 'POST'] as const;

/**
 * Mounts better-auth on the Fastify instance Nest owns.
 *
 * better-auth speaks the Web Fetch API (Request/Response); Fastify speaks Node
 * streams. This adapter is the bridge, taken from better-auth's Fastify
 * integration guide. Mounting directly avoids depending on a third-party Nest
 * wrapper for the one piece of infrastructure everything else authenticates
 * against (ADR-0002).
 */
export function mountBetterAuth(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();

  fastify.route({
    method: [...METHODS],
    url: AUTH_ROUTE,
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);

      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });

      const response = await auth.handler(webRequest);

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });

      return reply.send(response.body ? await response.text() : null);
    },
  });
}
