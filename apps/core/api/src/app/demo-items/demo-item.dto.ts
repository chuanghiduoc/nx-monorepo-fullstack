import { CURSOR_MAX_LENGTH, MAX_PAGE_LIMIT } from '@workspace/core-server-core';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MAX_TITLE_LENGTH = 200;

/**
 * One Zod schema produces three things: runtime validation, the TypeScript
 * type, and the OpenAPI schema the client is generated from. Keeping them in
 * one definition is what stops the three from drifting apart.
 */
const createDemoItemSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
});

const demoItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const listDemoItemsQuerySchema = z.object({
  /** Opaque; produced by a previous page and handed back unchanged. */
  cursor: z.string().max(CURSOR_MAX_LENGTH).optional(),
  // Query strings are strings; coerce here so the OpenAPI document still
  // describes an integer and the client sends `?limit=50`, not `?limit="50"`.
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
});

const demoItemPageSchema = z.object({
  items: z.array(demoItemSchema),
  /** `null` means there is nothing after this page — no separate flag. */
  // The length bound is real (see CURSOR_MAX_LENGTH) and it is also what
  // makes Zod emit `anyOf` here rather than `type: ["string", "null"]`, which
  // @nestjs/swagger misreads as an array. The emitter refuses the latter;
  // see openapi/assert-no-collapsed-nullables.ts.
  nextCursor: z.string().max(CURSOR_MAX_LENGTH).nullable(),
});

export class CreateDemoItemDto extends createZodDto(createDemoItemSchema) {}
export class ListDemoItemsQueryDto extends createZodDto(
  listDemoItemsQuerySchema,
) {}
export class DemoItemDto extends createZodDto(demoItemSchema) {}
export class DemoItemPageDto extends createZodDto(demoItemPageSchema) {}
