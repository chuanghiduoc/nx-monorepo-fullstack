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
      /DemoItemPageDto\.nextCursor/,
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
      /Outer\.list\[\]\.deep, Outer\.either\.anyOf\[0\]\.alt/,
    );
  });

  it('accepts a document with no schemas', () => {
    expect(() => assertNoCollapsedNullables({})).not.toThrow();
  });
});
