'use client';

import {
  backupCodeSchema,
  twoFactorSchema,
  type BackupCode,
  type TwoFactor,
} from '@workspace/shared-contracts';
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@workspace/shared-ui';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { authClient } from '../../../lib/auth-client';
import { useFormResolver } from '../../../lib/use-form-resolver';
import { safeNext } from '../../../lib/safe-next';

const CODE_LENGTH = 6;

/**
 * The second factor, with the way out for somebody who has lost the device.
 *
 * The backup codes exist for exactly this screen: a person reaches it when
 * they cannot produce a code, and offering only the six-digit field would lock
 * out the one case the codes were printed for.
 */
export function TwoFactorForm() {
  const t = useTranslations('auth.twoFactor');
  const router = useRouter();
  const destination = safeNext(useSearchParams().get('next'));
  const [failed, setFailed] = useState(false);
  const [usingBackupCode, setUsingBackupCode] = useState(false);

  const codeForm = useForm<TwoFactor>({
    resolver: useFormResolver(twoFactorSchema),
    defaultValues: { code: '' },
  });

  const backupForm = useForm<BackupCode>({
    resolver: useFormResolver(backupCodeSchema),
    defaultValues: { code: '' },
  });

  function arrive() {
    router.push(destination);
    router.refresh();
  }

  async function submitCode(values: TwoFactor) {
    setFailed(false);

    const { error } = await authClient.twoFactor.verifyTotp({
      code: values.code,
    });

    if (error) {
      setFailed(true);
      codeForm.reset({ code: '' });
      return;
    }

    arrive();
  }

  async function submitBackupCode(values: BackupCode) {
    setFailed(false);

    const { error } = await authClient.twoFactor.verifyBackupCode({
      code: values.code,
    });

    if (error) {
      setFailed(true);
      backupForm.reset({ code: '' });
      return;
    }

    arrive();
  }

  function choose(backup: boolean) {
    setFailed(false);
    setUsingBackupCode(backup);
  }

  if (usingBackupCode) {
    return (
      <form
        className="w-full space-y-4 pt-6"
        noValidate
        onSubmit={backupForm.handleSubmit(submitBackupCode)}
      >
        <Field data-invalid={Boolean(backupForm.formState.errors.code) || undefined}>
          <FieldLabel htmlFor="backup-code">{t('backupCode')}</FieldLabel>
          <Input
            aria-invalid={Boolean(backupForm.formState.errors.code)}
            autoFocus
            id="backup-code"
            {...backupForm.register('code')}
          />
          <FieldError errors={[backupForm.formState.errors.code]} />
        </Field>

        {failed ? (
          <p
            className="rounded-xl bg-destructive/10 px-3 py-2 text-destructive text-sm"
            role="alert"
          >
            {t('backupFailed')}
          </p>
        ) : null}

        <Button
          className="w-full"
          disabled={backupForm.formState.isSubmitting}
          type="submit"
        >
          {t('submit')}
        </Button>

        <Button
          className="w-full"
          onClick={() => choose(false)}
          type="button"
          variant="ghost"
        >
          {t('useCode')}
        </Button>
      </form>
    );
  }

  return (
    <form
      className="w-full space-y-4 pt-6"
      noValidate
      onSubmit={codeForm.handleSubmit(submitCode)}
    >
      <Field
        className="items-center"
        data-invalid={Boolean(codeForm.formState.errors.code) || undefined}
      >
        <FieldLabel htmlFor="code">{t('code')}</FieldLabel>
        {/* One box per digit, so a six-digit code is read back at a glance and
            a mistyped one is obvious before it is submitted. */}
        <Controller
          control={codeForm.control}
          name="code"
          render={({ field }) => (
            <InputOTP
              autoFocus
              id="code"
              maxLength={CODE_LENGTH}
              onChange={field.onChange}
              value={field.value}
            >
              <InputOTPGroup>
                {Array.from({ length: CODE_LENGTH }, (_, index) => (
                  <InputOTPSlot index={index} key={index} />
                ))}
              </InputOTPGroup>
            </InputOTP>
          )}
        />
        <FieldError errors={[codeForm.formState.errors.code]} />
      </Field>

      {failed ? (
        <p
          className="rounded-xl bg-destructive/10 px-3 py-2 text-destructive text-sm"
          role="alert"
        >
          {t('failed')}
        </p>
      ) : null}

      <Button
        className="w-full"
        disabled={codeForm.formState.isSubmitting}
        type="submit"
      >
        {t('submit')}
      </Button>

      <Button
        className="w-full"
        onClick={() => choose(true)}
        type="button"
        variant="ghost"
      >
        {t('useBackupCode')}
      </Button>
    </form>
  );
}
