import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { AppModule } from './app/app.module';

const OUTPUT_FILE = 'openapi.json';
const API_VERSION = '1.0.0';

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

  const config = new DocumentBuilder()
    .setTitle('core-api')
    .setDescription(
      'Errors follow RFC 9457 (application/problem+json); see docs/contracts/problem-details.md.',
    )
    .setVersion(API_VERSION)
    .addCookieAuth('better-auth.session_token')
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .build();

  // nestjs-zod v5 post-processes the document instead of patching the swagger
  // module: the Zod DTOs become proper OpenAPI schemas here.
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));

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
