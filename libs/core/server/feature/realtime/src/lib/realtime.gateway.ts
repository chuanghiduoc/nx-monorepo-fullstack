import { Inject, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import {
  RealtimeBus,
  type Unsubscribe,
} from '@workspace/core-server-realtime';
import type { Server } from 'socket.io';

import { SOCKET_PATH } from './redis-io.adapter.js';

/**
 * The other transport, for the traffic that goes both ways.
 *
 * One bus listener for every socket this replica holds, not one per socket:
 * the room is on the message and Socket.IO already indexes sockets by room, so
 * a single `emit` reaches exactly the right ones.
 *
 * `local` is deliberate. The message reached this replica over the bus, and
 * every other replica received the same message on its own subscription — a
 * cluster-wide emit here would send it once per replica, so a browser
 * connected to any of them would see it as many times as there are replicas.
 *
 * The gateway subscribes to nothing on the client's behalf and accepts no
 * message that asks it to. Rooms are joined at the handshake, from the
 * resolved session.
 */
@WebSocketGateway({ path: SOCKET_PATH })
export class RealtimeGateway implements OnModuleDestroy {
  @WebSocketServer()
  private readonly server!: Server;

  private readonly bus: RealtimeBus;
  private off?: Unsubscribe;

  constructor(@Inject(RealtimeBus) bus: RealtimeBus) {
    this.bus = bus;
  }

  /**
   * Starts relaying once the socket server exists.
   *
   * `afterInit` rather than `onModuleInit`: the server is injected by the
   * gateway machinery after the module is built, and a listener registered
   * earlier would fire with nothing to emit on.
   */
  afterInit(): void {
    this.off = this.bus.onMessage((message) => {
      this.server.local.to(message.room).emit(message.name, {
        name: message.name,
        at: message.at,
        data: message.data,
      });
    });
  }

  onModuleDestroy(): void {
    this.off?.();
    this.off = undefined;
  }
}
