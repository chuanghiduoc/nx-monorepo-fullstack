import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

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
    // Preview mode builds the module graph without instantiating providers, so
    // nothing here opens a connection. Without it the sentence above was only
    // an intention: the constructors that dial Redis ran anyway, and emitting
    // the contract failed wherever Redis was not already running — CI, where
    // no service backs this step, being the case that found it. The document
    // comes from decorator metadata on the classes, which needs no instances.
    { logger: false, preview: true },
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
