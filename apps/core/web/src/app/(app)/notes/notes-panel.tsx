'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  notesControllerCreateMutation,
  notesControllerListInfiniteOptions,
  notesControllerListInfiniteQueryKey,
  notesControllerRemoveMutation,
} from '@workspace/shared-api-client-core';
import {
  createNoteSchema,
  type CreateNoteInput,
} from '@workspace/shared-contracts';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';

import { Button, Field, FieldError, FieldLabel, Input, Textarea } from '@workspace/shared-ui';
import { useActiveOrganization } from '../../../lib/use-session';
import { useFormResolver } from '../../../lib/use-form-resolver';

/**
 * The reference feature, from the browser.
 *
 * Every call goes through the client generated from the API's own description
 * of itself, so a change to a route or a field breaks the build here rather
 * than at runtime in front of somebody.
 */
export function NotesPanel() {
  const t = useTranslations('notes');
  const queries = useQueryClient();
  const listKey = notesControllerListInfiniteQueryKey();
  const { organisation, pending: sessionPending } = useActiveOrganization();

  // Paged, not truncated. A plain list shows the first page and gives no sign
  // the rest exist, so a note past the twentieth would be unreachable — and
  // undeletable — with nothing on screen to say so.
  const notes = useInfiniteQuery({
    ...notesControllerListInfiniteOptions(),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // The API answers 403 without an active organization, and asking anyway
    // would put an error on screen where an explanation belongs.
    enabled: Boolean(organisation),
  });

  const invalidate = () => queries.invalidateQueries({ queryKey: listKey });

  const create = useMutation({
    ...notesControllerCreateMutation(),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    ...notesControllerRemoveMutation(),
    onSuccess: invalidate,
  });

  const form = useForm<CreateNoteInput>({
    resolver: useFormResolver(createNoteSchema),
    defaultValues: { title: '', body: '' },
  });

  function onSubmit(values: CreateNoteInput) {
    // `mutate`, not `mutateAsync`: the async form rejects, the form library
    // re-throws, and nothing is left to catch it — so a failed save reports
    // itself twice, once on screen and once as an unhandled rejection.
    create.mutate(
      { body: values },
      { onSuccess: () => form.reset({ title: '', body: '' }) },
    );
  }

  if (sessionPending) {
    return <Shell title={t('title')}>{t('loading')}</Shell>;
  }

  if (!organisation) {
    // Not an error: the person is signed in, they are simply not working
    // anywhere yet, and the fix is one click away in the header.
    return <Shell title={t('title')}>{t('needsOrganization')}</Shell>;
  }

  const items = notes.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
        <Field data-invalid={Boolean(form.formState.errors.title) || undefined}>
          <FieldLabel htmlFor="title">{t('noteTitle')}</FieldLabel>
          <Input id="title" aria-invalid={Boolean(form.formState.errors.title)} {...form.register('title')} />
          <FieldError errors={[form.formState.errors.title]} />
        </Field>
        <Field data-invalid={Boolean(form.formState.errors.body) || undefined}>
          <FieldLabel htmlFor="body">{t('body')}</FieldLabel>
          <Textarea rows={3} id="body" aria-invalid={Boolean(form.formState.errors.body)} {...form.register('body')} />
          <FieldError errors={[form.formState.errors.body]} />
        </Field>
        {create.isError ? (
          <p role="alert" className="text-sm text-red-600">
            {t('saveFailed')}
          </p>
        ) : null}
        <Button type="submit" disabled={create.isPending} className="w-full">
          {t('submit')}
        </Button>
      </form>

      {notes.isPending ? (
        <p className="text-neutral-500">{t('loading')}</p>
      ) : null}

      {notes.isError ? (
        <p role="alert" className="text-red-600">
          {t('loadFailed')}
        </p>
      ) : null}

      {remove.isError ? (
        <p role="alert" className="text-red-600">
          {t('deleteFailed')}
        </p>
      ) : null}

      {!notes.isPending && !notes.isError && items.length === 0 ? (
        <p className="text-neutral-500">{t('empty')}</p>
      ) : null}

      <ul className="space-y-3">
        {items.map((note) => (
          <li
            key={note.id}
            className="flex items-start justify-between gap-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <div>
              <p className="font-medium">{note.title}</p>
              {note.body ? (
                <p className="text-sm whitespace-pre-wrap text-neutral-500">
                  {note.body}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              // Named after the note. Every button in this list would
              // otherwise announce as "Delete note", and a screen reader gives
              // no way to tell which row is about to go.
              aria-label={t('deleteNamed', { title: note.title })}
              onClick={() => remove.mutate({ path: { id: note.id } })}
              disabled={remove.isPending}
              className="text-sm text-red-600 hover:underline disabled:opacity-50"
            >
              {t('delete')}
            </button>
          </li>
        ))}
      </ul>

      {notes.hasNextPage ? (
        <button
          type="button"
          onClick={() => void notes.fetchNextPage()}
          disabled={notes.isFetchingNextPage}
          className="text-sm underline disabled:opacity-50"
        >
          {notes.isFetchingNextPage ? t('loading') : t('loadMore')}
        </button>
      ) : null}
    </section>
  );
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-neutral-500">{children}</p>
    </section>
  );
}
