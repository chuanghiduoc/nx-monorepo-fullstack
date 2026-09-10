import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  RealtimeBus,
  matchesNames,
  type RealtimeMessage,
  type Unsubscribe,
} from '@workspace/core-server-realtime';

/** What a subscriber is handed. */
export type StreamListener = (message: RealtimeMessage) => void;

interface Subscription {
  readonly names: readonly string[];
  readonly listener: StreamListener;
}

/**
 * The SSE streams this replica is holding, indexed by room.
 *
 * One registration on the bus for all of them, rather than one per connected
 * client. With a listener per client the room check would live in as many
 * places as there are clients and every message would be offered to every one
 * of them; here a message is offered only to the subscriptions in its own room.
 *
 * Every `subscribe` returns the way out, and the controller calls it when the
 * client's stream is torn down. That is the whole of the leak story: a browser
 * that closed its tab, a proxy that timed out, a process shutting down — all
 * of them arrive as an unsubscribe, and none of them leaves a `Set` growing.
 */
@Injectable()
export class RealtimeStreams implements OnModuleInit, OnModuleDestroy {
  private readonly bus: RealtimeBus;
  private readonly rooms = new Map<string, Set<Subscription>>();
  private off?: Unsubscribe;

  constructor(@Inject(RealtimeBus) bus: RealtimeBus) {
    this.bus = bus;
  }

  onModuleInit(): void {
    this.off = this.bus.onMessage((message) => {
      this.deliver(message);
    });
  }

  onModuleDestroy(): void {
    this.off?.();
    this.off = undefined;
    this.rooms.clear();
  }

  /**
   * Everything published to that room, until the returned function is called.
   *
   * The room is the caller's to supply and the caller derives it from the
   * request's own tenant — never from anything the client sent. `names` filters
   * within the room; empty means all of them.
   */
  subscribe(
    room: string,
    names: readonly string[],
    listener: StreamListener,
  ): Unsubscribe {
    const subscription: Subscription = { names, listener };
    const existing = this.rooms.get(room);

    if (existing === undefined) {
      this.rooms.set(room, new Set([subscription]));
    } else {
      existing.add(subscription);
    }

    return () => {
      const held = this.rooms.get(room);

      if (held === undefined) {
        return;
      }

      held.delete(subscription);

      // The empty `Set` goes too. Left behind, a service that has seen a
      // million organizations holds a million empty sets — a leak that grows
      // with traffic rather than with connections, which is the harder one to
      // notice.
      if (held.size === 0) {
        this.rooms.delete(room);
      }
    };
  }

  /** How many streams this replica holds for that room. For the tests. */
  countIn(room: string): number {
    return this.rooms.get(room)?.size ?? 0;
  }

  private deliver(message: RealtimeMessage): void {
    const held = this.rooms.get(message.room);

    if (held === undefined) {
      return;
    }

    // A copy, because a listener may unsubscribe itself while being called —
    // an SSE stream whose client has gone does exactly that — and mutating a
    // `Set` during its own iteration silently skips entries.
    for (const subscription of [...held]) {
      if (matchesNames(message, subscription.names)) {
        subscription.listener(message);
      }
    }
  }
}
