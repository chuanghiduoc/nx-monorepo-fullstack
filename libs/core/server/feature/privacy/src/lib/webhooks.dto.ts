import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MAX_URL = 2048;
const MAX_EVENT_TYPES = 50;

const createWebhookSchema = z.object({
  /**
   * Where to send. Checked again — resolved and validated against the address
   * ranges — before it is stored and before every delivery: the address a name
   * points at is not a property of the string, and it can change in between.
   */
  url: z.url().max(MAX_URL),

  /**
   * Which event types this endpoint wants. Empty means all of them, which is
   * the useful default for a first endpoint and the wrong one for a busy
   * integration.
   */
  eventTypes: z.array(z.string().min(1).max(128)).max(MAX_EVENT_TYPES).default([]),
});

export class CreateWebhookDto extends createZodDto(createWebhookSchema) {}

const updateWebhookSchema = z
  .object({
    url: z.url().max(MAX_URL).optional(),
    eventTypes: z.array(z.string().min(1).max(128)).max(MAX_EVENT_TYPES).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Change at least one of url, eventTypes or enabled.',
  });

export class UpdateWebhookDto extends createZodDto(updateWebhookSchema) {}

/**
 * One endpoint, as a caller sees it.
 *
 * A schema rather than a `createZodDto` class of its own: nothing takes a
 * single endpoint as a body or returns one on its own, so a class here would
 * be a name for something no route uses.
 */
const webhookSchema = z.object({
  id: z.uuidv7(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
});

/**
 * The one response that carries the secret.
 *
 * `app_user` holds no `SELECT` on that column, so no route can ever produce it
 * again — not because a handler chooses not to, but because the grant does not
 * permit the read. A caller that loses it creates a new endpoint.
 */
const createdWebhookSchema = webhookSchema.extend({
  secret: z.string(),
});

export class CreatedWebhookDto extends createZodDto(createdWebhookSchema) {}

const webhookListSchema = z.object({ items: z.array(webhookSchema) });

export class WebhookListDto extends createZodDto(webhookListSchema) {}
