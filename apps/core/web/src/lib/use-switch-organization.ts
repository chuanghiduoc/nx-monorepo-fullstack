'use client';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@workspace/shared-ui';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { authClient } from './auth-client';

interface SwitchOrganization {
  readonly switchTo: (organizationId: string) => void;
  readonly switching: boolean;
}

/**
 * Changes the organization the session acts in, and empties the query cache.
 *
 * The two belong together. The service reads the tenant from the session, so
 * it appears in no request the cache can see: two organizations would share
 * one entry, and whichever was read first would be shown to the second. That
 * makes this the one operation nobody may perform by calling `setActive`
 * directly, and the reason it is a hook rather than four lines repeated in
 * every component that offers the choice.
 *
 * Emptying is more honest than marking stale: stale data is still shown while
 * it refetches, and here that would be another organization's rows on screen.
 */
export function useSwitchOrganization(): SwitchOrganization {
  const t = useTranslations('organizations');
  const queries = useQueryClient();
  const [switching, startSwitching] = useTransition();

  function switchTo(organizationId: string) {
    // In a transition so the control disables: two fast clicks would issue two
    // calls whose arrival order decides the tenant.
    startSwitching(async () => {
      const { error } = await authClient.organization.setActive({
        organizationId,
      });

      if (error) {
        // A toast rather than a message on the page: the control that started
        // this is in the header, and by the time the answer arrives the reader
        // may be looking at something else entirely.
        toast.error(t('switchFailed'));
        return;
      }

      queries.clear();
    });
  }

  return { switchTo, switching };
}
