import { Body, Controller, Get, Inject, Post, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import {
  CreateDemoItemDto,
  DemoItemDto,
  DemoItemPageDto,
} from './demo-item.dto';
import { DemoItemsService } from './demo-items.service';

const RESOURCE_PATH = '/api/v1/demo-items';

@ApiTags('demo-items')
@Controller({ path: 'v1/demo-items' })
export class DemoItemsController {
  private readonly service: DemoItemsService;

  constructor(@Inject(DemoItemsService) service: DemoItemsService) {
    this.service = service;
  }

  @Get()
  @ApiOkResponse({ type: DemoItemPageDto })
  list(): Promise<DemoItemPageDto> {
    return this.service.list();
  }

  @Post()
  // Declared explicitly rather than inferred: the swagger CLI plugin would have
  // to run in every build path that emits the document, including the emitter.
  @ApiBody({ type: CreateDemoItemDto })
  @ApiCreatedResponse({ type: DemoItemDto })
  async create(
    @Body() body: CreateDemoItemDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DemoItemDto> {
    const item = await this.service.create(body);

    // 201 carries the location of what was created, so the client does not have
    // to construct the URL itself.
    reply.status(201).header('location', `${RESOURCE_PATH}/${item.id}`);

    return item;
  }
}
