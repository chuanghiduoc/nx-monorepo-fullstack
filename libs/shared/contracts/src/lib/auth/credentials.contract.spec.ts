import { describe, expect, it } from 'vitest';

import {
  createOrganizationSchema,
  signInSchema,
  signUpSchema,
  twoFactorSchema,
} from './credentials.contract.js';

/** Written out rather than imported: a test that reads the constant it is
 * checking passes for any value of it. */
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_NAME = 100;
const MAX_SLUG = 60;

describe('the credentials contract', () => {
  it('refuses something that is not an address', () => {
    expect(signInSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(
      false,
    );
  });

  it('asks for a password long enough to be worth having', () => {
    const short = signUpSchema.safeParse({
      name: 'A Person',
      email: 'person@example.com',
      password: 'short',
    });

    expect(short.success).toBe(false);
  });

  it('accepts a password of exactly the minimum length', () => {
    // The boundary itself, not one either side of it: an off-by-one here
    // refuses a password the service would have taken.
    const exact = signUpSchema.safeParse({
      name: 'A Person',
      email: 'person@example.com',
      password: 'a'.repeat(MIN_PASSWORD),
    });

    expect(exact.success).toBe(true);
  });

  it('refuses a password longer than the service will hash', () => {
    const tooLong = signUpSchema.safeParse({
      name: 'A Person',
      email: 'person@example.com',
      password: 'a'.repeat(MAX_PASSWORD + 1),
    });

    expect(tooLong.success).toBe(false);
  });

  it('refuses a name of nothing but spaces', () => {
    const blank = signUpSchema.safeParse({
      name: '   ',
      email: 'person@example.com',
      password: 'a-long-enough-password',
    });

    expect(blank.success).toBe(false);
  });

  it('refuses a name longer than the column holds', () => {
    const tooLong = signUpSchema.safeParse({
      name: 'a'.repeat(MAX_NAME + 1),
      email: 'person@example.com',
      password: 'a-long-enough-password',
    });

    expect(tooLong.success).toBe(false);
  });

  it('accepts a sign-up that meets every rule', () => {
    const good = signUpSchema.safeParse({
      name: 'A Person',
      email: 'person@example.com',
      password: 'a-long-enough-password',
    });

    expect(good.success).toBe(true);
  });

  it('takes six digits and nothing else as a second factor', () => {
    expect(twoFactorSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(twoFactorSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(twoFactorSchema.safeParse({ code: '1234567' }).success).toBe(false);
    expect(twoFactorSchema.safeParse({ code: 'abcdef' }).success).toBe(false);
    // A newline would otherwise slip past an unanchored pattern.
    expect(twoFactorSchema.safeParse({ code: '123456\n' }).success).toBe(false);
  });

  it('keeps an organization identifier to what a URL can carry', () => {
    const accepted = ['acme', 'acme-2', 'a1', 'a'.repeat(MAX_SLUG)];
    const refused = [
      'Acme',
      'acme_2',
      '-acme',
      'acme-',
      'acme corp',
      '',
      'a'.repeat(MAX_SLUG + 1),
    ];

    for (const slug of accepted) {
      expect(
        createOrganizationSchema.safeParse({ name: 'Acme', slug }).success,
      ).toBe(true);
    }

    for (const slug of refused) {
      expect(
        createOrganizationSchema.safeParse({ name: 'Acme', slug }).success,
      ).toBe(false);
    }
  });
});
