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
import type { FileRecord } from '@workspace/core-server-data-access-db';

import {
  CompleteUploadDto,
  DownloadDto,
  FileDto,
  FileListDto,
  RequestUploadDto,
  UploadTicketDto,
} from './files.dto.js';
import { FilesService } from './files.service.js';

const NO_CONTENT = 204;

@ApiTags('files')
@Controller({ path: 'v1/files' })
export class FilesController {
  private readonly files: FilesService;

  constructor(@Inject(FilesService) files: FilesService) {
    this.files = files;
  }

  @Get()
  @ApiOkResponse({ type: FileListDto })
  async list(@CurrentPrincipal() principal: Principal): Promise<FileListDto> {
    const items = await this.files.list(principal, organisationOf(principal));

    return { items: items.map(toDto) };
  }

  /**
   * Asks for somewhere to put the bytes.
   *
   * The response is a ticket rather than an upload: the record exists, in
   * `PENDING`, and the caller now has a signed way to fill it. Nothing here
   * has seen a byte.
   */
  @Post()
  @ApiCreatedResponse({ type: UploadTicketDto })
  async requestUpload(
    @CurrentPrincipal() principal: Principal,
    @Body() body: RequestUploadDto,
  ): Promise<UploadTicketDto> {
    const ticket = await this.files.requestUpload(
      principal,
      organisationOf(principal),
      {
        fileName: body.fileName,
        contentType: body.contentType,
        shape: body.shape,
        ...(body.partCount === undefined ? {} : { partCount: body.partCount }),
      },
    );

    return {
      file: toDto(ticket.file),
      shape: ticket.shape,
      ...(ticket.url === undefined ? {} : { url: ticket.url }),
      ...(ticket.fields === undefined ? {} : { fields: ticket.fields }),
      ...(ticket.uploadId === undefined ? {} : { uploadId: ticket.uploadId }),
      ...(ticket.parts === undefined ? {} : { parts: ticket.parts }),
      expiresAt: ticket.expiresAt.toISOString(),
    };
  }

  /**
   * Says the upload finished.
   *
   * The one transition a request may make. What it does **not** do is decide
   * the file is usable — that needs the bytes read, which is the scanner's
   * job and the reason `app_user` cannot write any other column.
   */
  @Post(':id/complete')
  @ApiOkResponse({ type: FileDto })
  async complete(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompleteUploadDto,
  ): Promise<FileDto> {
    const file = await this.files.completeUpload(
      principal,
      organisationOf(principal),
      id,
      body.uploadId === undefined || body.parts === undefined
        ? undefined
        : { uploadId: body.uploadId, parts: body.parts },
    );

    return toDto(file);
  }

  @Get(':id/download')
  @ApiOkResponse({ type: DownloadDto })
  async download(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DownloadDto> {
    const signed = await this.files.download(
      principal,
      organisationOf(principal),
      id,
    );

    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  @Delete(':id')
  @HttpCode(NO_CONTENT)
  @ApiNoContentResponse()
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.files.remove(principal, organisationOf(principal), id);
  }
}

/**
 * What a caller sees. Never the object key.
 *
 * The key is how the store finds the object, and a caller that knew it would
 * be one signed URL away from a file it was never granted — the whole reason
 * downloads go through a route that checks first.
 */
function toDto(file: FileRecord): FileDto {
  return {
    id: file.id,
    fileName: file.fileName,
    declaredType: file.declaredType,
    detectedType: file.detectedType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    reason: file.reason,
    createdAt: file.createdAt.toISOString(),
  };
}

function organisationOf(principal: Principal): string {
  const orgId = principal.type === 'system' ? undefined : principal.orgId;

  if (!orgId) {
    throw new ForbiddenException(
      'Files belong to an organization. Choose one before using this route.',
    );
  }

  return orgId;
}
