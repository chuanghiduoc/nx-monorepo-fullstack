import { z } from 'zod';

import { pageOf, pageQuerySchema } from '../pagination/page.js';

const MAX_TITLE_LENGTH = 200;

/**
 * The smallest possible resource, kept as a worked example.
 *
 * One schema produces three things: validation at runtime, the TypeScript
 * type, and the published description a client is generated from. Keeping
 * them in one definition is what stops the three from drifting apart.
 */
export const createDemoItemSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
});

export const demoItemSchema = z.object({
  id: z.uuidv7(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const demoItemPageSchema = pageOf(demoItemSchema);

export const listDemoItemsQuerySchema = pageQuerySchema;

export type CreateDemoItem = z.infer<typeof createDemoItemSchema>;
export type DemoItem = z.infer<typeof demoItemSchema>;
export type DemoItemPage = z.infer<typeof demoItemPageSchema>;
