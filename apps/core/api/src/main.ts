import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { Logger as PinoLogger } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import ScalarApiReference from '@scalar/fastify-api-reference';

import { IdempotencyStore } from '@workspace/core-server-data-access-db';

import {
  AppConfig,
  IdempotencyInterceptor,
  OriginCheckGuard,
  ProblemDetailsFilter,
  REQUEST_ID_HEADER,
  requestIdOptions,
} from '@workspace/core-server-core';

import {
  AuthService,
  mountBetterAuth,
} from '@workspace/core-server-feature-auth';

import { AppModule } from './app/app.module';
import { buildOpenApiDocument } from './app/openapi/build-document';

const DEFAULT_PORT = 3000;
const GLOBAL_PREFIX = 'api';
const DOCS_PATH = '/docs';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Behind the edge proxy the client address and protocol arrive
    // in X-Forwarded-* headers; without trustProxy, secure cookies and rate
    // limiting would see the proxy instead of the caller.
    new FastifyAdapter({ trustProxy: true, ...requestIdOptions }),
  );
  // Framework logs go through pino too, so everything is one JSON stream.
  app.useLogger(app.get(PinoLogger));
  app.setGlobalPrefix(GLOBAL_PREFIX);

  const config = app.get(AppConfig);
  const allowedOrigins = config.get('CORS_ORIGINS');

  // Security headers first: they must apply to every response, including errors.
  await app.register(helmet, {
    // The API serves JSON, never HTML, so the strictest CSP costs nothing.
    // useDefaults: false, because helmet's defaults include style-src
    // 'unsafe-inline' — meaningless for JSON, and a false signal in an audit.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  // Every DTO is a Zod schema; this is what makes them reject bad input rather
  // than merely describe it.
  app.useGlobalPipes(new ZodValidationPipe());

  // One error shape for the whole service (RFC 9457).
  app.useGlobalFilters(new ProblemDetailsFilter());

  // CSRF: SameSite cookies plus an origin check on state-changing requests.
  app.useGlobalGuards(new OriginCheckGuard(allowedOrigins));

  // Retries of a mutation that carries an Idempotency-Key replay the first
  // result instead of doing the work twice.
  app.useGlobalInterceptors(
    new IdempotencyInterceptor(app.get(IdempotencyStore)),
  );

  // Echo the id so a caller can quote it when reporting a problem.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, _payload, done) => {
      reply.header(REQUEST_ID_HEADER, request.id);
      done();
    });

  // better-auth owns /api/auth/* and is mounted on the Fastify instance itself,
  // outside Nest's router.
  mountBetterAuth(app, app.get(AuthService).instance);

  // Interactive docs render the very document the client is generated from.
  // Off in production unless DOCS_ENABLED says otherwise.
  if (config.get('DOCS_ENABLED') ?? !config.isProduction) {
    await app.register(ScalarApiReference, {
      routePrefix: DOCS_PATH,
      // No external fonts, so the page works with a CSP that names only
      // ourselves — and inside an air-gapped network.
      configuration: {
        content: buildOpenApiDocument(app),
        withDefaultFonts: false,
      },
      hooks: {
        // The API-wide CSP is default-src 'none'. The docs page runs a bundled
        // script and an inline bootstrap, so its own routes — and only those —
        // get a policy that allows them; @fastify/helmet lets a reply replace
        // the headers the global hook already set.
        onRequest: (_request, reply, done) => {
          reply.helmet({
            contentSecurityPolicy: {
              useDefaults: false,
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:'],
                fontSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                frameAncestors: ["'none'"],
              },
            },
          });
          done();
        },
      },
    });
  }

  const configuredPort = Number(process.env.PORT);
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0
      ? configuredPort
      : DEFAULT_PORT;

  // Lets Nest run onModuleDestroy/onApplicationShutdown handlers on SIGTERM,
  // which the worker's graceful drain and rolling deploys depend on.
  app.enableShutdownHooks();
  // Containers need 0.0.0.0 to accept traffic from outside the container; a
  // developer machine should not put the API on the local network.
  const host =
    process.env.HOST ??
    (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);

  Logger.log(
    `🚀 core-api is running on http://localhost:${port}/${GLOBAL_PREFIX}`,
  );
}

bootstrap().catch((error: unknown) => {
  // The message, not just the stack: Nest's Logger treats a second argument as
  // a stack trace, so passing the error object alone prints a failure with no
  // reason — and the reason is the only useful part of a boot failure.
  const reason = error instanceof Error ? error.message : String(error);
  Logger.error(`core-api failed to start: ${reason}`);
  if (error instanceof Error && error.stack) {
    Logger.error(error.stack);
  }
  process.exitCode = 1;
});
