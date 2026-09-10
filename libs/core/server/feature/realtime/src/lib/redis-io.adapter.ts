import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Principal } from '@workspace/core-server-authz';
import type { Redis } from 'ioredis';
import { ServerOptions, Server as SocketServer } from 'socket.io';

import { audienceFor } from './realtime.audience.js';
import { roomFor } from '@workspace/core-server-realtime';

/** Where the client connects. Under `/api`, like everything else this serves. */
export const SOCKET_PATH = '/api/realtime/socket.io';

/** What the middleware resolves a connection's identity with. */
export type PrincipalResolver = (
  headers: Record<string, string | string[] | undefined>,
) => Promise<Principal | undefined>;

export interface RedisIoAdapterOptions {
  /** The connection the Redis adapter duplicates for its own pair. */
  readonly redis: Redis;
  readonly origins: readonly string[];
  readonly resolvePrincipal: PrincipalResolver;
}

/**
 * Socket.IO, wired to Redis and to the same identity the HTTP path resolves.
 *
 * **The handshake is verified once, at connect.** A socket that connected
 * before its session was checked is a socket that will be checked never: after
 * the handshake there is no request to hang a guard on, and every message it
 * sends for the next hour arrives on a connection nobody ever authenticated.
 * The resolver is the application's own, handed in rather than imported, so
 * there is one implementation of "who is this" and it is not copied here.
 *
 * **The room is joined by the server, from the resolved principal.** The client
 * is never asked which room it wants. It could only answer with a string, and
 * one string is as good as another.
 *
 * The Redis adapter is installed although the bus already fans out on its own.
 * The bus delivers locally, so cross-instance delivery is handled — but the
 * next thing anybody writes is `server.to(room).emit(...)` in their own code,
 * and without the adapter that quietly reaches one replica's sockets. A
 * boilerplate that is wrong when extended in the obvious way is worse than one
 * that is missing the feature.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private readonly options: RedisIoAdapterOptions;

  constructor(app: INestApplicationContext, options: RedisIoAdapterOptions) {
    super(app);
    this.options = options;
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      path: SOCKET_PATH,
      // Cookies, because that is what the session is. Without credentials the
      // browser sends none and every connection resolves to anonymous.
      cors: { origin: [...this.options.origins], credentials: true },
      // Websocket only. Long-polling spreads one logical connection over
      // several HTTP requests, which need sticky sessions at the edge — and
      // the Redis adapter does not make that go away, it only makes the
      // *messages* cross instances.
      transports: ['websocket'],
    }) as SocketServer;

    const pub = this.options.redis.duplicate();
    const sub = this.options.redis.duplicate();
    server.adapter(createAdapter(pub, sub));

    server.use((socket, next) => {
      this.options
        .resolvePrincipal(socket.handshake.headers)
        .then((principal) => {
          if (principal === undefined) {
            // The connection is refused rather than accepted-and-ignored: a
            // socket held open with no identity is a socket somebody will
            // eventually send something on.
            next(new Error('This connection needs a signed-in session.'));
            return;
          }

          socket.data.principal = principal;
          void socket.join(roomFor(audienceFor(principal)));
          next();
        })
        .catch((failure: unknown) => {
          this.logger.warn(
            `Refused a socket whose identity could not be resolved: ${
              failure instanceof Error ? failure.message : String(failure)
            }`,
          );
          next(new Error('This connection needs a signed-in session.'));
        });
    });

    return server;
  }
}
