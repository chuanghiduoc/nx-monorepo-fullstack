import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app/app.module';

const DEFAULT_PORT = 3000;
const GLOBAL_PREFIX = 'api';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.setGlobalPrefix(GLOBAL_PREFIX);

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
