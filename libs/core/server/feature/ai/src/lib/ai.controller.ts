import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '@workspace/core-server-authz';
import { CurrentPrincipal } from '@workspace/core-server-core';
import type { AiDocumentRecord } from '@workspace/core-server-data-access-db';
import { Observable } from 'rxjs';

import {
  AiDocumentDto,
  AiDocumentListDto,
  AskQueryDto,
  IngestDocumentDto,
} from './ai.dto.js';
import { RagService } from './rag.service.js';

const NO_CONTENT = 204;

@ApiTags('ai')
@Controller({ path: 'v1/ai' })
export class AiController {
  private readonly rag: RagService;

  constructor(@Inject(RagService) rag: RagService) {
    this.rag = rag;
  }

  @Get('documents')
  @ApiOkResponse({ type: AiDocumentListDto })
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiDocumentListDto> {
    const items = await this.rag.list(principal, organisationOf(principal));

    return { items: items.map(toDto) };
  }

  @Post('documents')
  @ApiCreatedResponse({ type: AiDocumentDto })
  async ingest(
    @CurrentPrincipal() principal: Principal,
    @Body() body: IngestDocumentDto,
  ): Promise<AiDocumentDto> {
    const document = await this.rag.ingest(
      principal,
      organisationOf(principal),
      {
        title: body.title,
        ...(body.source === undefined ? {} : { source: body.source }),
        text: body.text,
      },
    );

    return toDto(document);
  }

  @Delete('documents/:id')
  @HttpCode(NO_CONTENT)
  @ApiNoContentResponse()
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.rag.remove(principal, organisationOf(principal), id);
  }

  /**
   * Asks, and watches the answer arrive.
   *
   * **Its own stream, not the realtime bus.** The bus is a tenant broadcast:
   * every browser in the organization would receive somebody else's answer,
   * token by token. What this borrows from realtime is the shape — a response
   * that stays open — and nothing else.
   *
   * A `GET` because that is what an `EventSource` sends, and because a question
   * is a read: it changes nothing, and a retried one costs a second answer
   * rather than a second document.
   *
   * Three kinds of event: `citations` once, before any text, because the search
   * decided them and a reader can see where an answer is coming from while it
   * is still arriving; `delta` for each piece of text; `done` with the token
   * counts.
   */
  @Sse('ask')
  @ApiOkResponse({
    description:
      'A text/event-stream carrying one "citations" event, then a "delta" ' +
      'event per piece of text, then one "done" event with the token counts.',
  })
  async ask(
    @CurrentPrincipal() principal: Principal,
    @Query() query: AskQueryDto,
  ): Promise<Observable<MessageEvent>> {
    const orgId = organisationOf(principal);

    // **Before the first `await`, and that is the point.** Measured: a global
    // interceptor turns the handler's result into an Observable, so Nest
    // commits the SSE headers on the next macrotask — anything refused after
    // real asynchronous work arrives as an `error` event on a 200 instead of a
    // status code. A rejection from here is still a microtask, so it beats the
    // commit and the caller gets a 403 or a 503.
    //
    // What cannot make that deadline is the token ceiling, which needs a
    // database read. It arrives as an `error` event, and the contract says so.
    this.rag.assertCanAsk(principal, orgId);

    const retrieved = await this.rag.prepare(principal, orgId, query.question);

    return new Observable<MessageEvent>((subscriber) => {
      // `cancelled` rather than an AbortSignal into the provider: the SDK call
      // is already in flight, and stopping it mid-stream would leave the tokens
      // spent and the record unwritten. This stops *pushing* to a subscriber
      // that has gone, which is what a closed stream actually needs.
      let cancelled = false;

      // The citations first, and synchronously: they came from the search, so
      // a reader can see where an answer is coming from while it is still
      // arriving.
      subscriber.next({
        type: 'citations',
        data: JSON.stringify(retrieved.citations),
      });

      this.rag
        .answer(retrieved, (delta) => {
          if (!cancelled) {
            subscriber.next({ type: 'delta', data: delta });
          }
        })
        .then((answer) => {
          if (!cancelled) {
            subscriber.next({
              type: 'done',
              data: JSON.stringify({
                inputTokens: answer.inputTokens,
                outputTokens: answer.outputTokens,
              }),
            });
            subscriber.complete();
          }
        })
        .catch((failure: unknown) => {
          if (!cancelled) {
            subscriber.error(failure);
          }
        });

      return () => {
        cancelled = true;
      };
    });
  }
}

function toDto(document: AiDocumentRecord): AiDocumentDto {
  return {
    id: document.id,
    title: document.title,
    source: document.source,
    chunkCount: document.chunkCount,
    createdAt: document.createdAt.toISOString(),
  };
}

function organisationOf(principal: Principal): string {
  const orgId = principal.type === 'system' ? undefined : principal.orgId;

  if (!orgId) {
    throw new ForbiddenException(
      'Documents belong to an organization. Choose one before using this route.',
    );
  }

  return orgId;
}
