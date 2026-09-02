import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

const API_VERSION = '1.0.0';

/**
 * The one place the OpenAPI document is produced. The emitter writes it to
 * disk for the generated client; the running service hands the same object to
 * the docs UI — so what a developer reads at /docs is what the client was
 * generated from, never a second description that can drift.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
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
  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
}
