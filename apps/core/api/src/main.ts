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
import multipart from '@fastify/multipart';
import ScalarApiReference from '@scalar/fastify-api-reference';

import { IdempotencyStore } from '@workspace/core-server-data-access-db';

import {
  AppConfig,
  IdempotencyInterceptor,
  OriginCheckGuard,
  ProblemDetailsFilter,
  REQUEST_ID_HEADER,
  reportBootFailure,
  requestIdOptions,
  stopOnSignal,
} from '@workspace/core-server-core';

import {
  AuthService,
  mountBetterAuth,
  mountTenantContext,
  principalFromHeaders,
} from '@workspace/core-server-feature-auth';

import { RedisIoAdapter } from '@workspace/core-server-feature-realtime';
import { REALTIME_REDIS } from '@workspace/core-server-realtime';

import {
  METRICS,
  TRACING,
  mountHttpInstrumentation,
  type Metrics,
  type Tracing,
} from '@workspace/core-server-observability';

import { AppModule } from './app/app.module';
import { buildOpenApiDocument } from './app/openapi/build-document';

const GLOBAL_PREFIX = 'api';
const DOCS_PATH = '/docs';

/**
 * Paths that are measured but never traced.
 *
 * A scrape every fifteen seconds is a trace every fifteen seconds that says
 * nothing and costs storage forever; the readiness probe is the same story at a
 * higher rate.
 */
const UNTRACED = ['/api/metrics', '/api'];

/**
 * The tracer, once the application has built it, so the signal handler can
 * flush what its exporter is holding.
 *
 * Module scope because `stopOnSignal` is registered against the *promise* of a
 * started application — a signal arriving mid-boot has to be handled — and it
 * therefore cannot reach anything `start()` holds.
 */
let tracingRef: Tracing | undefined;

async function start(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Behind the edge the client address and protocol arrive in X-Forwarded-*
    // headers; without this, secure cookies and rate limiting would see the
    // edge instead of the caller. It names the hops it trusts rather than
    // trusting all of them: `true` would let any client set its own address,
    // and the per-organization IP allowlist would then guard nothing.
    //
    // Read from the environment directly because the adapter is built before
    // the configuration module exists. The schema still validates it at boot.
    new FastifyAdapter({
      trustProxy: (process.env['TRUSTED_PROXIES'] ?? '127.0.0.1,::1')
        .split(',')
        .map((hop) => hop.trim())
        .filter(Boolean),
      ...requestIdOptions,
    }),
    {
      // Everything the framework logs before `useLogger` runs goes through
      // pino too, rather than out as Nest's own console format — one JSON
      // stream from the first line.
      bufferLogs: true,
      // Nest's default wraps the dependency scan in an `ExceptionsZone` whose
      // teardown is `process.exit(1)`, so a provider that throws in its
      // constructor bypasses the `catch` below entirely. Measured: `PORT` out
      // of range exited 1 with no `core-api failed to start` line anywhere.
      abortOnError: false,
    },
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
    // Spelled out because the plugin's default is GET, HEAD and POST only. A
    // browser refuses any method the preflight did not name, so leaving this
    // out makes every update and delete fail from a page while continuing to
    // work from a tool that sends no origin at all.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Without this a browser may read only the six safelisted response
    // headers. Every one of these is set deliberately and is useless to the
    // one caller that cannot see it: the id to quote when reporting a problem,
    // the delay to wait before retrying, and the address of what was created.
    exposedHeaders: [REQUEST_ID_HEADER, 'retry-after', 'location'],
    // How long a browser may reuse one preflight answer. Without it every
    // cross-origin edit and delete pays a second round trip, forever.
    maxAge: config.get('CORS_MAX_AGE_SECONDS'),
  });

  // A browser form upload is `multipart/form-data`, which Fastify has no
  // parser for. Registered always rather than only for the `local` storage
  // driver: a body parser that differs between deployments is a difference the
  // tests cannot see. It parses nothing unless a handler asks it to.
  await app.register(multipart);

  // Bodies Fastify has no parser for arrive as the stream itself.
  //
  // Without this an upload — `image/png`, `application/octet-stream`, anything
  // a caller actually sends — is refused with 415 before any handler runs.
  // The change this makes elsewhere is small and deliberate: a JSON route sent
  // an unregistered content type used to answer 415 and now answers 400 from
  // the schema. The parsers for `application/json` and `text/plain` are
  // registered already and still win, because Fastify matches an exact content
  // type before this fallback.
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });

  // Every DTO is a Zod schema; this is what makes them reject bad input rather
  // than merely describe it.
  app.useGlobalPipes(new ZodValidationPipe());

  // One error shape for the whole service (RFC 9457).
  app.useGlobalFilters(
    new ProblemDetailsFilter(config.get('PROBLEM_TYPE_BASE_URL')),
  );

  // CSRF: SameSite cookies plus an origin check on state-changing requests.
  app.useGlobalGuards(new OriginCheckGuard(allowedOrigins));

  // Retries of a mutation that carries an Idempotency-Key replay the first
  // result instead of doing the work twice.
  const metrics = app.get<Metrics>(METRICS);

  app.useGlobalInterceptors(
    new IdempotencyInterceptor(app.get(IdempotencyStore), (route) => {
      metrics.idempotencyConflicts.inc({ route });
    }),
  );

  // A span and a timer around every request, on the Fastify instance rather
  // than as a Nest interceptor: an interceptor never sees a request that
  // matched no route, and those are exactly the ones somebody is looking for.
  //
  // The registry and the tracer are the module's — one owner — and are read
  // back here because the hook goes on Fastify rather than on Nest.
  tracingRef = app.get<Tracing>(TRACING);

  mountHttpInstrumentation(app.getHttpAdapter().getInstance(), {
    metrics,
    untraced: UNTRACED,
  });

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
  const auth = app.get(AuthService).instance;
  mountBetterAuth(app, auth);

  // Identity is resolved before any handler, and therefore before any
  // transaction: the database call it makes is one the root client refuses
  // once a transaction is open.
  mountTenantContext(app, auth);

  // Sockets attach to the raw HTTP server and never reach the hook above, so
  // the handshake resolves identity itself — with the same function, handed in
  // rather than reimplemented. Installed before `listen`, because the adapter
  // is what builds the socket server.
  app.useWebSocketAdapter(
    new RedisIoAdapter(app, {
      redis: app.get(REALTIME_REDIS),
      origins: allowedOrigins,
      resolvePrincipal: (headers) => principalFromHeaders(auth, headers),
    }),
  );

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

  // Read through the validated configuration rather than from the environment
  // directly: a malformed value should stop the service at boot with the name
  // of the variable, not decide quietly which port to listen on.
  const port = config.get('PORT');

  // Nest's own `enableShutdownHooks` is deliberately not used, here or in the
  // worker. It re-raises the signal once the hooks have run, so the process
  // dies *by* the signal — exit 143 — and whatever pino had queued on stdout
  // goes with it. `useProcessExit: true` changes the exit code and not the
  // flush, because `process.exit` does not drain an asynchronous stdout
  // either. Owning the signal is what allows close, then flush, then exit.
  //
  // Containers need 0.0.0.0 to accept traffic from outside the container; a
  // developer machine should not put the API on the local network.
  const host =
    config.get('HOST') ?? (config.isProduction ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);

  Logger.log(
    `🚀 core-api is running on http://localhost:${port}/${GLOBAL_PREFIX}`,
  );

  return app;
}

// Registered against the promise rather than the started application, so a
// signal arriving during the seconds a boot takes is handled rather than
// meeting the default disposition. There is nothing to do before the close:
// `app.close()` stops accepting, lets the requests in flight finish, and then
// runs the lifecycle hooks.
const starting = start();

stopOnSignal(starting, {
  name: 'core-api',
  // Flushes whatever the span processor is holding. Without it the last
  // seconds before a shutdown — which is when the interesting spans usually
  // are — go with the process.
  afterClose: () => tracingRef?.shutdown(),
});

starting.catch((error: unknown) => {
  reportBootFailure('core-api', error);
});
