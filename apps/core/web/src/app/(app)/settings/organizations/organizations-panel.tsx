'use client';

import {
  createOrganizationSchema,
  type CreateOrganization,
} from '@workspace/shared-contracts';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';

import { Button, Field, FieldError, FieldLabel, Input } from '@workspace/shared-ui';
import { authClient } from '../../../../lib/auth-client';
import { useSession } from '../../../../lib/use-session';
import { useFormResolver } from '../../../../lib/use-form-resolver';
import { useSwitchOrganization } from '../../../../lib/use-switch-organization';

export function OrganizationsPanel() {
  const t = useTranslations('organizations');
  const { data: session } = useSession();
  const {
    data: organizations,
    isPending,
    error,
    refetch,
  } = authClient.useListOrganizations();
  const { switchTo, switching } = useSwitchOrganization();

  const form = useForm<CreateOrganization>({
    resolver: useFormResolver(createOrganizationSchema),
    defaultValues: { name: '', slug: '' },
  });

  async function onSubmit(values: CreateOrganization) {
    const { data, error: failure } =
      await authClient.organization.create(values);

    if (failure || !data) {
      form.setError('slug', { message: t('createFailed') });
      return;
    }

    form.reset({ name: '', slug: '' });
    await refetch();

    // A new organization nobody is working in is a dead end; creating one is
    // an intention to use it. Through the hook, so the cache filled as the
    // previous tenant is emptied here too.
    switchTo(data.id);
  }

  const active = session?.session.activeOrganizationId;

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      {isPending ? <p className="text-neutral-500">{t('loading')}</p> : null}

      {error ? (
        <p role="alert" className="text-red-600">
          {t('loadFailed')}
        </p>
      ) : null}

      {!isPending && !error && organizations?.length === 0 ? (
        <p className="text-neutral-500">{t('none')}</p>
      ) : null}

      {organizations && organizations.length > 0 ? (
        <ul className="space-y-2">
          {organizations.map((organization) => (
            <li
              key={organization.id}
              className="flex items-center justify-between gap-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <span>{organization.name}</span>
              {organization.id === active ? (
                <span className="text-sm text-neutral-500">{t('current')}</span>
              ) : (
                <button
                  type="button"
                  aria-label={t('switchTo', { name: organization.name })}
                  disabled={switching}
                  onClick={() => switchTo(organization.id)}
                  className="text-sm hover:underline disabled:opacity-50"
                >
                  {t('switch')}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
        <h2 className="text-lg font-medium">{t('create')}</h2>
        <Field data-invalid={Boolean(form.formState.errors.name) || undefined}>
          <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
          <Input id="name" aria-invalid={Boolean(form.formState.errors.name)} {...form.register('name')} />
          <FieldError errors={[form.formState.errors.name]} />
        </Field>
        <Field data-invalid={Boolean(form.formState.errors.slug) || undefined}>
          <FieldLabel htmlFor="slug">{t('slug')}</FieldLabel>
          <Input id="slug" aria-invalid={Boolean(form.formState.errors.slug)} {...form.register('slug')} />
          <FieldError errors={[form.formState.errors.slug]} />
        </Field>
        <Button
          type="submit"
          disabled={form.formState.isSubmitting}
          className="w-full"
        >
          {t('submit')}
        </Button>
      </form>
    </section>
  );
}
