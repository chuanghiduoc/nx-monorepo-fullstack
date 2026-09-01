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

const demoItemPageSchema = z.object({
  items: z.array(demoItemSchema),
  /** `null` means there is nothing after this page — no separate flag. */
  nextCursor: z.string().nullable(),
});

export class CreateDemoItemDto extends createZodDto(createDemoItemSchema) {}
export class DemoItemDto extends createZodDto(demoItemSchema) {}
export class DemoItemPageDto extends createZodDto(demoItemPageSchema) {}
