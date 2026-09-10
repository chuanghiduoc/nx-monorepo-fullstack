import {
  Controller,
  Inject,
  MessageEvent,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Principal } from '@workspace/core-server-authz';
import { AppConfig, CurrentPrincipal } from '@workspace/core-server-core';
import { roomFor } from '@workspace/core-server-realtime';
import { Observable } from 'rxjs';

import { audienceFor } from './realtime.audience.js';
import { StreamQueryDto, namesFrom } from './realtime.dto.js';
import { RealtimeStreams } from './realtime.streams.js';

const MILLISECONDS = 1_000;

/** What an idle stream carries so that something between here and the browser
 * does not decide the connection is dead. */
const HEARTBEAT = 'ping';

/**
 * One-way events, over an ordinary HTTP GET.
 *
 * SSE rather than a socket wherever the traffic only goes one way: it is a
 * response that never ends, so it needs no handshake of its own, survives any
 * proxy that does not buffer, and reconnects by itself. A progress bar needs
 * exactly this and nothing more.
 *
 * Identity comes from the ordinary request path — this is a `GET`, so the hook
 * that resolves a principal for every request has already run, and
 * `CurrentPrincipal` refuses an anonymous one. There is nothing extra to
 * remember here, which is the reason to prefer this shape.
 */
@ApiTags('realtime')
@Controller({ path: 'v1/realtime' })
export class RealtimeController {
  private readonly streams: RealtimeStreams;
  private readonly config: AppConfig;

  constructor(
    @Inject(RealtimeStreams) streams: RealtimeStreams,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.streams = streams;
    this.config = config;
  }

  @Sse('stream')
  @ApiOkResponse({
    description:
      'A text/event-stream that stays open. Each event carries the event name ' +
      'as its type and a JSON body. A "ping" event arrives on an idle stream ' +
      'and means nothing but "still here".',
  })
  stream(
    @CurrentPrincipal() principal: Principal,
    @Query() query: StreamQueryDto,
  ): Observable<MessageEvent> {
    const room = roomFor(audienceFor(principal));
    const names = namesFrom(query);
    const heartbeatMs =
      this.config.get('REALTIME_HEARTBEAT_SECONDS') * MILLISECONDS;

    return new Observable<MessageEvent>((subscriber) => {
      const off = this.streams.subscribe(room, names, (message) => {
        subscriber.next({
          type: message.name,
          data: JSON.stringify({
            name: message.name,
            at: message.at,
            data: message.data,
          }),
        });
      });

      const heartbeat = setInterval(() => {
        subscriber.next({ type: HEARTBEAT, data: '' });
      }, heartbeatMs);

      // Every exit path runs this: the client closed the tab, the proxy timed
      // out, the process is shutting down. Without it each of those leaves a
      // subscription and a timer behind, and the leak grows with traffic
      // rather than with anything anybody watches.
      return () => {
        off();
        clearInterval(heartbeat);
      };
    });
  }
}
