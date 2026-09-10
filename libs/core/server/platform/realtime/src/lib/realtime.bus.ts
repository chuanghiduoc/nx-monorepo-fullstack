import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  roomFor,
  type RealtimeAudience,
  type RealtimeMessage,
} from './realtime.message.js';
import { REALTIME_CHANNEL, REALTIME_REDIS } from './realtime.tokens.js';

/** A registered listener, and how to take it off again. */
export type Unsubscribe = () => void;

/**
 * The one way anything reaches a connected browser.
 *
 * Every message is published on a single Redis Pub/Sub channel; every replica
 * subscribes and delivers to the clients it holds. One mechanism for both
 * transports, so an event a Socket.IO client sees and one an SSE client sees
 * are the same event, published once.
 *
 * **The publisher does not deliver to its own clients directly.** It publishes,
 * and its own subscriber connection receives the message like every other
 * replica's — delivering locally *as well* would send one event twice to
 * everybody connected to the publishing replica.
 *
 * **Best effort, deliberately.** Redis Pub/Sub stores nothing: a message
 * published while a browser is between reconnects is gone. The outbox remains
 * the durable path and the source of truth; this is a notification that
 * something happened, and a client that missed one re-reads through the
 * ordinary API. Anything that must survive a reconnect is a row in a table and
 * a fetch on connect, not a message here.
 */
@Injectable()
export class RealtimeBus implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeBus.name);
  private readonly redis: Redis;
  private readonly channel: string;
  private readonly listeners = new Set<(message: RealtimeMessage) => void>();

  /**
   * The subscribing connection, created on the first `onMessage`.
   *
   * Lazy because a process that only publishes — the worker — would otherwise
   * hold an idle subscription to a channel it never reads. ioredis also refuses
   * to publish on a connection that is subscribed, so this cannot be the same
   * client either way.
   */
  private subscriber?: Redis;

  constructor(
    @Inject(REALTIME_REDIS) redis: Redis,
    @Inject(REALTIME_CHANNEL) channel: string,
  ) {
    this.redis = redis;
    this.channel = channel;
  }

  /**
   * Announces something to everyone in that audience, on every replica.
   *
   * Call it **after** the transaction commits, never inside one: a message
   * announcing a write that then rolls back is a lie the client cannot detect,
   * and there is no second message that takes it back.
   */
  async publish(
    audience: RealtimeAudience,
    name: string,
    data: unknown,
  ): Promise<void> {
    const message: RealtimeMessage = {
      room: roomFor(audience),
      name,
      data,
      at: new Date().toISOString(),
    };

    await this.redis.publish(this.channel, JSON.stringify(message));
  }

  /**
   * Every message this replica receives, until the returned function is called.
   *
   * There are two of these per replica — the SSE streams and the Socket.IO
   * gateway — and each filters by room itself. Registering one listener per
   * connected client instead would put the room check in as many places as
   * there are clients.
   */
  onMessage(listener: (message: RealtimeMessage) => void): Unsubscribe {
    this.listeners.add(listener);
    void this.ensureSubscribed();

    return () => {
      this.listeners.delete(listener);
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();

    // The subscriber only: the publishing connection is provided by the module
    // and closed by whatever created it, which is the same rule the queue's
    // connection follows.
    if (this.subscriber !== undefined) {
      this.subscriber.disconnect();
      this.subscriber = undefined;
    }
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscriber !== undefined) {
      return;
    }

    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;

    subscriber.on('message', (channel, payload) => {
      if (channel !== this.channel) {
        return;
      }

      this.deliver(payload);
    });

    try {
      await subscriber.subscribe(this.channel);
    } catch (failure) {
      // A replica that cannot subscribe delivers nothing, and saying so is the
      // difference between "realtime is broken" and a silent stream. It is not
      // fatal: the API still answers every request, and realtime is best
      // effort by construction.
      this.subscriber = undefined;
      subscriber.disconnect();
      this.logger.error(
        `Not subscribed to "${this.channel}", so this instance delivers no realtime messages: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }

  private deliver(payload: string): void {
    let message: RealtimeMessage;

    try {
      message = JSON.parse(payload) as RealtimeMessage;
    } catch {
      // Something else is publishing on this channel. Dropping it is right;
      // saying nothing about it is not, because the usual cause is two
      // deployments sharing one Redis with the same REALTIME_CHANNEL.
      this.logger.warn(
        `Ignored a message on "${this.channel}" that is not one of ours.`,
      );
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (failure) {
        // One listener throwing must not stop the others: the SSE streams and
        // the socket gateway are independent, and a failure in one is not a
        // reason the other misses the event.
        this.logger.error(
          `A realtime listener threw on "${message.name}": ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        );
      }
    }
  }
}
