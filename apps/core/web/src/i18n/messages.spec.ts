import { describe, expect, it } from 'vitest';

import en from '../../messages/en.json';
import vi from '../../messages/vi.json';
import { LOCALES } from '@workspace/shared-i18n';

type Messages = Record<string, unknown>;

function paths(node: Messages, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = `${prefix}${key}`;
    return typeof value === 'object' && value !== null
      ? [path, ...paths(value as Messages, `${path}.`)]
      : [path];
  });
}

describe('message catalogues', () => {
  it('carry exactly the same keys', () => {
    // A key present in one language only renders as its own dotted path in the
    // other, which reaches production looking like a bug in the layout rather
    // than a missing translation.
    expect(paths(vi as Messages).sort()).toEqual(paths(en as Messages).sort());
  });

  it('cover every language the application offers', () => {
    // The catalogues and the list of languages are edited separately, so a
    // language can be offered with nothing to say in it.
    const catalogues: Record<string, unknown> = { vi, en };

    for (const locale of LOCALES) {
      expect(Object.keys(catalogues)).toContain(locale);
    }
  });

  it('leave no value empty', () => {
    const empty = (node: Messages, prefix = ''): string[] =>
      Object.entries(node).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? empty(value as Messages, `${prefix}${key}.`)
          : String(value).trim() === ''
            ? [`${prefix}${key}`]
            : [],
      );

    expect(empty(vi as Messages)).toEqual([]);
    expect(empty(en as Messages)).toEqual([]);
  });
});
