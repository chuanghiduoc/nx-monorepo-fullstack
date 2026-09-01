import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { Logger as PinoLogger } from 'nestjs-pino';
import {
  ProblemDetailsFilter,
  REQUEST_ID_HEADER,
  requestIdOptions,
} from '@workspace/core-server-core';

import { AppModule } from './app/app.module';
import { mountBetterAuth } from './app/auth/auth.handler';

const DEFAULT_PORT = 3000;
const GLOBAL_PREFIX = 'api';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Behind the edge proxy (spec §6.18) the client address and protocol arrive
    // in X-Forwarded-* headers; without trustProxy, secure cookies and rate
    // limiting would see the proxy instead of the caller.
    new FastifyAdapter({ trustProxy: true, ...requestIdOptions }),
  );
  // Framework logs go through pino too, so everything is one JSON stream.
  app.useLogger(app.get(PinoLogger));
  app.setGlobalPrefix(GLOBAL_PREFIX);

  // One error shape for the whole service (RFC 9457).
  app.useGlobalFilters(new ProblemDetailsFilter());

  // Echo the id so a caller can quote it when reporting a problem.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, _payload, done) => {
      reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });

  // better-auth owns /api/auth/* and is mounted on the Fastify instance itself,
  // outside Nest's router (ADR-0002).
  mountBetterAuth(app);

  const configuredPort = Number(process.env.PORT);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : DEFAULT_PORT;

  // Lets Nest run onModuleDestroy/onApplicationShutdown handlers on SIGTERM,
  // which the worker's graceful drain (Phase 4) and rolling deploys depend on.
  app.enableShutdownHooks();
  // Containers need 0.0.0.0 to accept traffic from outside the container; a
  // developer machine should not put the API on the local network.
  const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);

  Logger.log(`🚀 core-api is running on http://localhost:${port}/${GLOBAL_PREFIX}`);
}

bootstrap().catch((error) => {
  Logger.error('core-api failed to start', error);
  process.exitCode = 1;
});
