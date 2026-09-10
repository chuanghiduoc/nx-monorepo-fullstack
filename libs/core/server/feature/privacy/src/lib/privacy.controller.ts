import { Controller, Delete, Get, Inject, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '@workspace/core-server-authz';
import { CurrentPrincipal } from '@workspace/core-server-core';

import { ErasureRequestedDto, ErasureStatusDto } from './privacy.dto.js';
import { PrivacyService } from './privacy.service.js';

/**
 * The data subject's own routes.
 *
 * `/v1/me/erasure` rather than `/v1/users/:id/erasure`: there is no id to pass
 * because the only account any of these can act on is the caller's. A route
 * that took an id would need an answer about who may erase somebody else, and
 * the wrong answer there is unrecoverable.
 *
 * No permission check, and that is deliberate — a person needs no grant to ask
 * to be forgotten. The authorisation is authentication: the principal is who
 * the request is about.
 */
@ApiTags('privacy')
@Controller({ path: 'v1/me/erasure' })
export class PrivacyController {
  private readonly privacy: PrivacyService;

  constructor(@Inject(PrivacyService) privacy: PrivacyService) {
    this.privacy = privacy;
  }

  @Get()
  @ApiOkResponse({ type: ErasureStatusDto })
  async status(
    @CurrentPrincipal() principal: Principal,
  ): Promise<ErasureStatusDto> {
    const schedule = await this.privacy.statusOf(principal);

    return {
      erasureRequestedAt: schedule?.requestedAt.toISOString() ?? null,
      erasesAt: schedule?.erasesAt.toISOString() ?? null,
    };
  }

  /**
   * Asks to be forgotten.
   *
   * `POST` rather than `DELETE`, and the distinction is not pedantic: nothing
   * is deleted here. It schedules something, and the response says when — a
   * `DELETE` that returned 204 would tell a person their data was gone when it
   * has a month left.
   */
  @Post()
  @ApiOkResponse({ type: ErasureRequestedDto })
  async request(
    @CurrentPrincipal() principal: Principal,
  ): Promise<ErasureRequestedDto> {
    const schedule = await this.privacy.requestErasure(principal);

    return {
      erasureRequestedAt: schedule.requestedAt.toISOString(),
      erasesAt: schedule.erasesAt.toISOString(),
      graceDays: schedule.graceDays,
    };
  }

  /** Changes their mind, while there is still something to change. */
  @Delete()
  @ApiOkResponse({ type: ErasureStatusDto })
  async cancel(
    @CurrentPrincipal() principal: Principal,
  ): Promise<ErasureStatusDto> {
    await this.privacy.cancelErasure(principal);

    return { erasureRequestedAt: null, erasesAt: null };
  }
}
