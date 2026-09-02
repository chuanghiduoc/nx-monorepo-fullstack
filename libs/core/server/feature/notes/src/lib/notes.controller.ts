import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '@workspace/core-server-core';
import type { Principal } from '@workspace/core-server-authz';
import type { FastifyReply } from 'fastify';

import {
  CreateNoteDto,
  ListNotesQueryDto,
  NoteDto,
  NotePageDto,
  UpdateNoteDto,
} from './note.dto.js';
import { NotesService } from './notes.service.js';

const RESOURCE_PATH = '/api/v1/notes';
const NO_CONTENT = 204;

@ApiTags('notes')
@Controller({ path: 'v1/notes' })
export class NotesController {
  private readonly notes: NotesService;

  constructor(@Inject(NotesService) notes: NotesService) {
    this.notes = notes;
  }

  @Get()
  @ApiOkResponse({ type: NotePageDto })
  // Declared explicitly: without the swagger CLI plugin a @Query() DTO
  // contributes nothing to the document, and the generated client would have
  // no way to send a cursor.
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListNotesQueryDto,
  ): Promise<NotePageDto> {
    return this.notes.list(principal, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: NoteDto })
  find(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NoteDto> {
    return this.notes.find(principal, id);
  }

  @Post()
  @ApiBody({ type: CreateNoteDto })
  @ApiCreatedResponse({ type: NoteDto })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateNoteDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<NoteDto> {
    const note = await this.notes.create(principal, body);

    reply.status(201).header('location', `${RESOURCE_PATH}/${note.id}`);

    return note;
  }

  @Patch(':id')
  @ApiBody({ type: UpdateNoteDto })
  @ApiOkResponse({ type: NoteDto })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateNoteDto,
  ): Promise<NoteDto> {
    return this.notes.update(principal, id, body);
  }

  @Delete(':id')
  @HttpCode(NO_CONTENT)
  @ApiNoContentResponse()
  // Idempotent: deleting something already gone is success. A client retrying
  // a delete it never saw the answer to must not be told the resource
  // vanished mysteriously.
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.notes.remove(principal, id);
  }
}
