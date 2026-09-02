import { ForbiddenException, createParamDecorator } from '@nestjs/common';
import type { Principal } from '@workspace/core-server-authz';

import { currentRequestContext } from './request-context.storage.js';

/**
 * The principal the request resolved to.
 *
 * Refuses rather than yielding undefined: a handler that declares it needs a
 * principal has said the route is not anonymous, and handing it `undefined`
 * would push that decision into every handler, where one of them would
 * eventually forget.
 */
export const CurrentPrincipal = createParamDecorator((): Principal => {
  const context = currentRequestContext();

  if (!context) {
    throw new ForbiddenException('This route requires you to be signed in.');
  }

  return context.principal;
});
