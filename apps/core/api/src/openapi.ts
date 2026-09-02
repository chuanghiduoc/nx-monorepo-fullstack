import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app/app.module';
import { buildOpenApiDocument } from './app/openapi/build-document';

const OUTPUT_FILE = 'openapi.json';

/**
 * Emits the OpenAPI document and exits.
 *
 * The document is a build artifact committed to the repository: the generated
 * client is produced from it, CI fails when it drifts from the code, and a
 * polyglot service can read it without running anything.
 *
 * The application is created but never listens — emitting the contract must not
 * require a port or a database.
 */
async function emit(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false },
  );
  app.setGlobalPrefix('api');

  const document = buildOpenApiDocument(app);

  writeFileSync(
    join(__dirname, '..', OUTPUT_FILE),
    `${JSON.stringify(document, null, 2)}\n`,
    'utf-8',
  );

  await app.close();
}

emit()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Failed to emit the OpenAPI document', error);
    process.exit(1);
  });
