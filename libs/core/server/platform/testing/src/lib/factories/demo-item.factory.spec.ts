import { describe, expect, it } from 'vitest';

import { demoItemFactory } from './demo-item.factory.js';

describe('demoItemFactory', () => {
  it('builds a valid create request', () => {
    const input = demoItemFactory.build();

    expect(input.title.length).toBeGreaterThan(0);
    expect(input.title.length).toBeLessThanOrEqual(200);
  });

  it('never builds two items with the same title in one list', () => {
    // The sequence number is part of the title so a list can seed a table
    // that must be paged without ambiguity about which row is which.
    const titles = demoItemFactory.buildList(50).map((item) => item.title);

    expect(new Set(titles).size).toBe(titles.length);
  });

  it('accepts overrides', () => {
    expect(demoItemFactory.build({ title: 'fixed' }).title).toBe('fixed');
  });
});
