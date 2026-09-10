import { z } from 'zod';

const MIN_PASSWORD = 8;
const MAX_BACKUP_CODE = 100;
const MAX_PASSWORD = 200;
const MAX_NAME = 100;

/**
 * What the sign-in and sign-up forms accept.
 *
 * A browser that accepts a password the service will reject is a form that
 * lies to the person filling it in, and they only find out after submitting —
 * so the minimum here is the service's minimum.
 *
 * The address rule is the library's own, which refuses a bare hostname
 * (`someone@localhost`) and any non-ASCII local part. That is stricter than
 * the mail standard allows; it is stated here so the narrowing is a decision
 * rather than something inherited by accident.
 */
export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const signUpSchema = z.object({
  // Trimmed before measuring, so a name of spaces is not a name.
  name: z.string().trim().min(1).max(MAX_NAME),
  email: z.email(),
  password: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD),
});

/**
 * Proving it is still the account's owner at the keyboard.
 *
 * Asked for again before a change that would weaken the account, so that a
 * session left open on an unattended machine is not enough on its own.
 */
export const confirmPasswordSchema = z.object({
  password: z.string().min(1),
});

/** Six digits, the length every authenticator application produces. */
export const twoFactorSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
});

/**
 * One of the codes handed over at enrolment, for somebody who has lost the
 * device. Their shape is the authentication library's to decide, so only the
 * obvious is checked here: that something was typed.
 */
export const backupCodeSchema = z.object({
  code: z.string().trim().min(1).max(MAX_BACKUP_CODE),
});

const MAX_ORGANIZATION_NAME = 100;
const MAX_SLUG = 60;

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(MAX_ORGANIZATION_NAME),
  // The slug appears in URLs, so the character set is narrowed here rather
  // than left for the service to reject after the person has typed it.
  slug: z
    .string()
    .min(1)
    .max(MAX_SLUG)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
});

export type ConfirmPassword = z.infer<typeof confirmPasswordSchema>;
export type SignIn = z.infer<typeof signInSchema>;
export type SignUp = z.infer<typeof signUpSchema>;
export type TwoFactor = z.infer<typeof twoFactorSchema>;
export type BackupCode = z.infer<typeof backupCodeSchema>;
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
