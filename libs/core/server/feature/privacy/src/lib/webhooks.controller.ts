import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '@workspace/core-server-authz';
import { CurrentPrincipal } from '@workspace/core-server-core';

import {
  CreateWebhookDto,
  CreatedWebhookDto,
  UpdateWebhookDto,
  WebhookListDto,
} from './webhooks.dto.js';
import { WebhooksService } from './webhooks.service.js';

const NO_CONTENT = 204;

@ApiTags('webhooks')
@Controller({ path: 'v1/webhooks' })
export class WebhooksController {
  private readonly webhooks: WebhooksService;

  constructor(@Inject(WebhooksService) webhooks: WebhooksService) {
    this.webhooks = webhooks;
  }

  @Get()
  @ApiOkResponse({ type: WebhookListDto })
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<WebhookListDto> {
    const items = await this.webhooks.list(
      principal,
      organisationOf(principal),
    );

    return {
      items: items.map((endpoint) => ({
        ...endpoint,
        createdAt: endpoint.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Creates an endpoint and returns its secret **once**.
   *
   * There is no route that reads it back, and that is enforced by the grant
   * rather than by this file: `app_user` holds a column-level `SELECT` that
   * excludes it. A caller that loses the secret creates a new endpoint.
   */
  @Post()
  @ApiCreatedResponse({ type: CreatedWebhookDto })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateWebhookDto,
  ): Promise<CreatedWebhookDto> {
    const created = await this.webhooks.create(
      principal,
      organisationOf(principal),
      { url: body.url, eventTypes: body.eventTypes },
    );

    return { ...created, createdAt: created.createdAt.toISOString() };
  }

  @Patch(':id')
  @HttpCode(NO_CONTENT)
  @ApiNoContentResponse()
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWebhookDto,
  ): Promise<void> {
    await this.webhooks.update(principal, organisationOf(principal), id, body);
  }

  @Delete(':id')
  @HttpCode(NO_CONTENT)
  @ApiNoContentResponse()
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.webhooks.remove(principal, organisationOf(principal), id);
  }
}

/**
 * The organization this request acts in.
 *
 * An endpoint belongs to one, and a caller with none has nothing to manage —
 * so this is a 403 rather than an empty list, which would read as "you have no
 * endpoints" to somebody who simply has not chosen an organization.
 */
function organisationOf(principal: Principal): string {
  const orgId = principal.type === 'system' ? undefined : principal.orgId;

  if (!orgId) {
    throw new ForbiddenException(
      'Webhook endpoints belong to an organization. Choose one before using this route.',
    );
  }

  return orgId;
}
