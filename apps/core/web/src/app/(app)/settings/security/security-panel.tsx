'use client';

import {
  confirmPasswordSchema,
  twoFactorSchema,
  type ConfirmPassword,
  type TwoFactor,
} from '@workspace/shared-contracts';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button, Field, FieldError, FieldLabel, Input } from '@workspace/shared-ui';
import { PasswordField } from '../../../../components/password-field';
import { authClient } from '../../../../lib/auth-client';
import { useSession } from '../../../../lib/use-session';
import { useFormResolver } from '../../../../lib/use-form-resolver';

/** Six digits, the length every authenticator application produces. */
const CODE_LENGTH = 6;

interface Enrolment {
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}

/**
 * The enrolment answer, checked rather than asserted.
 *
 * The same endpoint answers `{ method: 'otp' }` with no secret when the
 * service is configured for one-time passwords instead. A cast would turn that
 * configuration change into a crash while rendering the backup codes; this
 * turns it into the error message the screen already has.
 */
function asEnrolment(data: unknown): Enrolment | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const { totpURI, backupCodes } = data as Record<string, unknown>;

  if (typeof totpURI !== 'string' || !Array.isArray(backupCodes)) {
    return undefined;
  }

  return {
    totpURI,
    backupCodes: backupCodes.filter(
      (code): code is string => typeof code === 'string',
    ),
  };
}

/**
 * Turning the second factor on and off.
 *
 * Enrolling takes two steps because one step is a trap: a secret that was
 * mis-scanned, or scanned into an application the person then deletes, would
 * lock them out of their own account at the next sign-in. Nothing is switched
 * on until a code from the new device comes back and matches.
 *
 * Both directions ask for the password again. A session left open on an
 * unattended machine must not be enough to remove the very control that
 * protects the account, nor to enrol a device the owner never sees.
 */
export function SecurityPanel() {
  const t = useTranslations('security');
  const { data: session } = useSession();
  const [enrolment, setEnrolment] = useState<Enrolment | undefined>();
  const [failed, setFailed] = useState(false);
  const [codeRejected, setCodeRejected] = useState(false);

  const enabled = session?.user.twoFactorEnabled === true;

  const passwordForm = useForm<ConfirmPassword>({
    resolver: useFormResolver(confirmPasswordSchema),
    defaultValues: { password: '' },
  });

  const codeForm = useForm<TwoFactor>({
    resolver: useFormResolver(twoFactorSchema),
    defaultValues: { code: '' },
  });

  async function beginEnrolment({ password }: ConfirmPassword) {
    setFailed(false);

    const { data, error } = await authClient.twoFactor.enable({ password });
    const enrolled = error ? undefined : asEnrolment(data);

    if (!enrolled) {
      setFailed(true);
      return;
    }

    setEnrolment(enrolled);
    passwordForm.reset({ password: '' });
  }

  async function confirmEnrolment({ code }: TwoFactor) {
    setCodeRejected(false);

    const { error } = await authClient.twoFactor.verifyTotp({ code });

    if (error) {
      setCodeRejected(true);
      codeForm.reset({ code: '' });
      return;
    }

    setEnrolment(undefined);
    codeForm.reset({ code: '' });
    // The session is not read again here. Verifying replaces it — the old one
    // is deleted and a new cookie set — and the client already refreshes on
    // any two-factor call. A second read racing that one can land first and
    // put the previous answer back on screen.
  }

  async function turnOff({ password }: ConfirmPassword) {
    setFailed(false);

    const { error } = await authClient.twoFactor.disable({ password });

    if (error) {
      setFailed(true);
      return;
    }

    setEnrolment(undefined);
    passwordForm.reset({ password: '' });
  }

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      <p className="text-neutral-500" data-testid="two-factor-state">
        {enabled ? t('enabled') : t('disabled')}
      </p>

      {enrolment ? null : (
        <form
          onSubmit={passwordForm.handleSubmit(
            enabled ? turnOff : beginEnrolment,
          )}
          className="space-y-3"
        >
          <Field
            data-invalid={
              Boolean(passwordForm.formState.errors.password) || undefined
            }
          >
            <FieldLabel htmlFor="confirm-password">
              {t('confirmPassword')}
            </FieldLabel>
            <PasswordField
              aria-invalid={Boolean(passwordForm.formState.errors.password)}
              autoComplete="current-password"
              id="confirm-password"
              {...passwordForm.register('password')}
            />
            <FieldError errors={[passwordForm.formState.errors.password]} />
          </Field>

          {failed ? (
            <p role="alert" className="text-sm text-red-600">
              {t('failed')}
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={passwordForm.formState.isSubmitting}
            className="w-full"
          >
            {enabled ? t('turnOff') : t('turnOn')}
          </Button>
        </form>
      )}

      {enrolment ? (
        <div className="space-y-3 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">{t('enrolTitle')}</h2>
          <p className="text-sm text-neutral-500">{t('enrolHint')}</p>
          {/* The address in text rather than only a code to scan: an
              authenticator on the same device as the browser has no camera to
              point at itself. */}
          <code
            data-testid="totp-uri"
            className="block break-all rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900"
          >
            {enrolment.totpURI}
          </code>

          <h3 className="font-medium">{t('backupTitle')}</h3>
          <p className="text-sm text-neutral-500">{t('backupHint')}</p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
            {enrolment.backupCodes.map((backupCode) => (
              <li key={backupCode}>{backupCode}</li>
            ))}
          </ul>

          <form
            onSubmit={codeForm.handleSubmit(confirmEnrolment)}
            className="space-y-3 pt-2"
          >
            <Field
              data-invalid={Boolean(codeForm.formState.errors.code) || undefined}
            >
              <FieldLabel htmlFor="enrolment-code">
                {t('confirmCode')}
              </FieldLabel>
              <Input
                aria-invalid={Boolean(codeForm.formState.errors.code)}
                autoComplete="one-time-code"
                id="enrolment-code"
                inputMode="numeric"
                maxLength={CODE_LENGTH}
                {...codeForm.register('code')}
              />
              <FieldError errors={[codeForm.formState.errors.code]} />
            </Field>

            {codeRejected ? (
              <p role="alert" className="text-sm text-red-600">
                {t('codeRejected')}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={codeForm.formState.isSubmitting}
              className="w-full"
            >
              {t('finish')}
            </Button>
          </form>
        </div>
      ) : null}
    </section>
  );
}
