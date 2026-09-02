import { describe, expect, it } from 'vitest';

import { assertNoCollapsedNullables } from './assert-no-collapsed-nullables.js';

const document = (schemas: Record<string, unknown>) => ({
  components: { schemas },
});

describe('assertNoCollapsedNullables', () => {
  it('names the property whose nullable became an array', () => {
    const raw = document({
      DemoItemPageDto: {
        type: 'object',
        properties: {
          // What @nestjs/swagger makes of Zod's `type: ["string", "null"]`.
          nextCursor: {
            'x-nestjs_zod-empty-type': true,
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    });

    expect(() => assertNoCollapsedNullables(raw)).toThrow(
      /components\.schemas\.DemoItemPageDto\.properties\.nextCursor/,
    );
  });

  it('accepts a genuine array, which carries no marker', () => {
    const raw = document({
      DemoItemPageDto: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object' } },
        },
      },
    });

    expect(() => assertNoCollapsedNullables(raw)).not.toThrow();
  });

  it('accepts the anyOf form a constrained nullable produces', () => {
    const raw = document({
      DemoItemPageDto: {
        type: 'object',
        properties: {
          nextCursor: {
            'x-nestjs_zod-empty-type': true,
            type: '',
            anyOf: [{ type: 'string', maxLength: 512 }, { type: 'null' }],
          },
        },
      },
    });

    expect(() => assertNoCollapsedNullables(raw)).not.toThrow();
  });

  it('looks inside nested objects, arrays and combinators', () => {
    const collapsed = {
      'x-nestjs_zod-empty-type': true,
      type: 'array',
      items: { type: 'number' },
    };
    const raw = document({
      Outer: {
        type: 'object',
        properties: {
          list: {
            type: 'array',
            items: { type: 'object', properties: { deep: collapsed } },
          },
          either: {
            anyOf: [{ type: 'object', properties: { alt: collapsed } }],
          },
        },
      },
    });

    expect(() => assertNoCollapsedNullables(raw)).toThrow(
      /Outer\.properties\.list\.items\.properties\.deep, .*Outer\.properties\.either\.anyOf\[0\]\.properties\.alt/,
    );
  });

  it('finds a collapsed nullable in an inline path schema', () => {
    // components.schemas is not the only place a schema appears: a response
    // declared inline, a parameter, additionalProperties. A guard with a blind
    // spot reads as coverage while providing none.
    const raw = {
      paths: {
        '/api/v1/things': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      'x-nestjs_zod-empty-type': true,
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(() => assertNoCollapsedNullables(raw)).toThrow(
      /paths.*things.*get.*responses/,
    );
  });

  it('finds one under additionalProperties', () => {
    const raw = document({
      Bag: {
        type: 'object',
        additionalProperties: {
          'x-nestjs_zod-empty-type': true,
          type: 'array',
          items: { type: 'string' },
        },
      },
    });

    expect(() => assertNoCollapsedNullables(raw)).toThrow(
      /Bag\.additionalProperties/,
    );
  });

  it('accepts a document with no schemas', () => {
    expect(() => assertNoCollapsedNullables({})).not.toThrow();
  });
});
