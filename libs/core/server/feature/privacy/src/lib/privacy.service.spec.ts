import { describe, expect, it } from 'vitest';

import { CreateWebhookDto, UpdateWebhookDto } from './webhooks.dto.js';

/**
 * The shapes a request may send.
 *
 * The routes themselves are exercised end to end in
 * `apps/core/api-e2e/src/privacy.e2e-spec.ts`, against a real session, a real
 * policy and the real grants — which is where a webhook feature can actually
 * be wrong. What is left for a unit test is the validation, and specifically
 * the two rules that are easy to write and easy to get backwards.
 */
describe('what a webhook request may say', () => {
  it('defaults an endpoint to every event type', () => {
    const parsed = CreateWebhookDto.schema.parse({
      url: 'https://example.com/hook',
    });

    // Empty means all of them: the useful default for a first endpoint, and
    // the wrong one for a busy integration — which is why it is a default
    // rather than the only option.
    expect(parsed.eventTypes).toEqual([]);
  });

  it('refuses something that is not a URL', () => {
    expect(() => CreateWebhookDto.schema.parse({ url: 'not a url' })).toThrow();
  });

  it('refuses a change that changes nothing', () => {
    // A `PATCH` with an empty body is a caller that thinks it did something.
    // Answering 204 would tell them it worked.
    expect(() => UpdateWebhookDto.schema.parse({})).toThrow();
  });

  it('accepts a change to any single field', () => {
    expect(UpdateWebhookDto.schema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(
      UpdateWebhookDto.schema.parse({ url: 'https://example.com/moved' }),
    ).toEqual({ url: 'https://example.com/moved' });
  });
});
