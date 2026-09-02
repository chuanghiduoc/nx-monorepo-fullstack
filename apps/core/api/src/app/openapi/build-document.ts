import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { assertNoCollapsedNullables } from './assert-no-collapsed-nullables';

const API_VERSION = '1.0.0';
const OPENAPI_VERSION = '3.1.0';

/**
 * The one place the OpenAPI document is produced. The emitter writes it to
 * disk for the generated client; the running service hands the same object to
 * the docs UI — so what a developer reads at /docs is what the client was
 * generated from, never a second description that can drift.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    // OpenAPI 3.1 speaks JSON Schema natively. Under 3.0, a Zod `.nullable`
    // came out as `type: array` — the generated client believed `nextCursor`
    // was a list of strings. Caught by reading the generated types, not by
    // any test, which is why now has one.
    .setOpenAPIVersion(OPENAPI_VERSION)
    .setTitle('core-api')
    .setDescription(
      'Errors follow RFC 9457 (application/problem+json).',
    )
    .setVersion(API_VERSION)
    .addCookieAuth('better-auth.session_token')
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .build();

  const raw = SwaggerModule.createDocument(app, config);

  // Must run on the raw document: the marker it looks for is removed by the
  // cleanup below.
  assertNoCollapsedNullables(raw);

  // nestjs-zod v5 post-processes the document instead of patching the swagger
  // module: the Zod DTOs become proper OpenAPI schemas here.
  return cleanupOpenApiDoc(raw, { version: '3.1' });
}
