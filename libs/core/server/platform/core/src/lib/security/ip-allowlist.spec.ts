import { describe, expect, it } from 'vitest';

import { isAddressAllowed } from './ip-allowlist.js';

describe('an empty allowlist', () => {
  it('admits everyone, because it is the absence of a rule', () => {
    // An organization that has configured nothing has not asked to be locked
    // out of its own data.
    expect(isAddressAllowed('203.0.113.9', [])).toBe(true);
  });
});

describe('addresses', () => {
  it('admits one that is listed', () => {
    expect(isAddressAllowed('203.0.113.9', ['203.0.113.9'])).toBe(true);
  });

  it('refuses one that is not', () => {
    expect(isAddressAllowed('203.0.113.10', ['203.0.113.9'])).toBe(false);
  });

  it('does not confuse a prefix for a match', () => {
    // The bug a string comparison grows: 10.0.0.10 starts with 10.0.0.1.
    expect(isAddressAllowed('10.0.0.10', ['10.0.0.1'])).toBe(false);
  });
});

describe('ranges', () => {
  it('admits an address inside one', () => {
    expect(isAddressAllowed('10.1.2.3', ['10.1.0.0/16'])).toBe(true);
  });

  it('refuses one outside', () => {
    expect(isAddressAllowed('10.2.2.3', ['10.1.0.0/16'])).toBe(false);
  });

  it('holds at the boundary', () => {
    expect(isAddressAllowed('10.1.0.0', ['10.1.0.0/16'])).toBe(true);
    expect(isAddressAllowed('10.1.255.255', ['10.1.0.0/16'])).toBe(true);
    expect(isAddressAllowed('10.0.255.255', ['10.1.0.0/16'])).toBe(false);
    expect(isAddressAllowed('10.2.0.0', ['10.1.0.0/16'])).toBe(false);
  });

  it('treats a single-address range as that address', () => {
    expect(isAddressAllowed('10.1.2.3', ['10.1.2.3/32'])).toBe(true);
    expect(isAddressAllowed('10.1.2.4', ['10.1.2.3/32'])).toBe(false);
  });
});

describe('IPv6', () => {
  it('admits a listed address', () => {
    expect(isAddressAllowed('2001:db8::1', ['2001:db8::1'])).toBe(true);
  });

  it('admits an address inside a range', () => {
    expect(isAddressAllowed('2001:db8::abcd', ['2001:db8::/32'])).toBe(true);
    expect(isAddressAllowed('2001:db9::abcd', ['2001:db8::/32'])).toBe(false);
  });

  it('matches a mapped IPv4 address against an IPv4 rule', () => {
    // What a dual-stack listener reports for an IPv4 client. A rule written
    // the obvious way must still match it.
    expect(isAddressAllowed('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true);
    expect(isAddressAllowed('::ffff:10.1.2.3', ['10.1.0.0/16'])).toBe(true);
  });
});

describe('malformed input', () => {
  it('refuses an address that cannot be parsed', () => {
    expect(isAddressAllowed('not-an-address', ['10.0.0.0/8'])).toBe(false);
  });

  it('ignores one bad rule among good ones', () => {
    // A typo must not lock an organization out of its own data.
    expect(isAddressAllowed('10.1.2.3', ['nonsense', '10.1.0.0/16'])).toBe(true);
  });

  it('refuses everyone when every rule is unusable', () => {
    // The alternative is worse: a misconfigured allowlist silently becoming
    // no allowlist at all.
    expect(isAddressAllowed('10.1.2.3', ['nonsense', 'also-nonsense'])).toBe(false);
  });
});
