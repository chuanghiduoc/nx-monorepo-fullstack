import {
  REDIS_START_TIMEOUT_MS,
  startRedis,
  type TestRedis,
} from '@workspace/core-server-testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RealtimeBus } from './realtime.bus.js';
import type { RealtimeMessage } from './realtime.message.js';

const CHANNEL = 'realtime-test';
const SUITE_TIMEOUT_MS = 60_000;

/** How long a message has to cross Redis before the wait gives up. */
const ARRIVAL_TIMEOUT_MS = 5_000;

const ORG = { kind: 'org', orgId: 'org-1' } as const;
const OTHER_ORG = { kind: 'org', orgId: 'org-2' } as const;
const LONE_USER = { kind: 'user', userId: 'user-3' } as const;

/**
 * The bus, against a real Redis and with two instances of it.
 *
 * Two, because the one property that matters cannot be observed with one: a
 * message published by the replica a browser is *not* connected to has to reach
 * that browser, and a bus that delivered locally would pass every single-
 * instance test while failing in every deployment with more than one.
 *
 * Two `RealtimeBus` objects with their own connections is that, honestly, and
 * without spawning two processes to find it out.
 */
describe('RealtimeBus', () => {
  let redis: TestRedis;
  let publisherClient: Redis;
  let subscriberClient: Redis;
  let publisher: RealtimeBus;
  let subscriber: RealtimeBus;

  beforeAll(async () => {
    redis = await startRedis();

    publisherClient = new Redis(redis.url);
    subscriberClient = new Redis(redis.url);
    publisher = new RealtimeBus(publisherClient, CHANNEL);
    subscriber = new RealtimeBus(subscriberClient, CHANNEL);
  }, REDIS_START_TIMEOUT_MS);

  afterAll(async () => {
    await publisher?.onModuleDestroy();
    await subscriber?.onModuleDestroy();
    publisherClient?.disconnect();
    subscriberClient?.disconnect();
    await redis?.stop();
  });

  /** Listeners this test added, taken off again whatever it did. */
  const registered: (() => void)[] = [];

  afterEach(() => {
    for (const off of registered.splice(0)) {
      off();
    }
  });

  function collect(bus: RealtimeBus): RealtimeMessage[] {
    const seen: RealtimeMessage[] = [];
    registered.push(bus.onMessage((message) => seen.push(message)));
    return seen;
  }

  it(
    'delivers a message published on one instance to a listener on another',
    async () => {
      const seen = collect(subscriber);

      await settle();
      await publisher.publish(ORG, 'note.created', { id: 'note-1' });

      const [message] = await waitFor(seen, 1);

      expect(message?.name).toBe('note.created');
      expect(message?.data).toEqual({ id: 'note-1' });
      expect(message?.room).toBe('org:org-1');
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'delivers it to the publishing instance exactly once',
    async () => {
      // The publisher's own subscriber connection receives what it published,
      // like every other replica's. If it also delivered locally, everybody
      // connected to the publishing replica would see the event twice — and
      // that is invisible until somebody has two instances.
      const seen = collect(publisher);

      await settle();
      await publisher.publish(ORG, 'note.created', { id: 'note-2' });
      await waitFor(seen, 1);

      // Long enough for a second copy to arrive if one were coming.
      await pause(300);

      expect(seen).toHaveLength(1);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'puts each audience in a room of its own',
    async () => {
      const seen = collect(subscriber);

      await settle();
      await publisher.publish(ORG, 'a', {});
      await publisher.publish(OTHER_ORG, 'b', {});
      await publisher.publish(LONE_USER, 'c', {});

      const messages = await waitFor(seen, 3);

      // The room is what keeps one organization's events out of another's
      // stream, and a person acting alone has a stream of their own.
      expect(messages.map((message) => message.room)).toEqual([
        'org:org-1',
        'org:org-2',
        'user:user-3',
      ]);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'stops delivering once a listener has unsubscribed',
    async () => {
      const seen: RealtimeMessage[] = [];
      const off = subscriber.onMessage((message) => seen.push(message));

      await settle();
      await publisher.publish(ORG, 'first', {});
      await waitFor(seen, 1);

      off();
      await publisher.publish(ORG, 'second', {});
      await pause(300);

      // A client that disconnects mid-stream leaves through this path. Without
      // it every disconnected browser keeps a listener alive, and the leak only
      // shows up as memory in a long-running process.
      expect(seen.map((message) => message.name)).toEqual(['first']);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'survives a listener that throws, and still reaches the others',
    async () => {
      const seen: RealtimeMessage[] = [];

      registered.push(
        subscriber.onMessage(() => {
          throw new Error('this listener is broken');
        }),
      );
      registered.push(subscriber.onMessage((message) => seen.push(message)));

      await settle();
      await publisher.publish(ORG, 'still.delivered', {});

      // The SSE streams and the socket gateway are independent; a failure in
      // one is not a reason the other misses the event.
      expect((await waitFor(seen, 1))[0]?.name).toBe('still.delivered');
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'ignores a message on the channel that is not one of ours',
    async () => {
      const seen = collect(subscriber);

      await settle();
      await publisherClient.publish(CHANNEL, 'not json at all');
      await publisher.publish(ORG, 'after.the.rubbish', {});

      // Two deployments sharing one Redis with the same channel is the usual
      // cause. Dropping the message is right; stopping the stream would not be.
      expect((await waitFor(seen, 1))[0]?.name).toBe('after.the.rubbish');
    },
    SUITE_TIMEOUT_MS,
  );
});

/**
 * Waits until the subscription is live.
 *
 * `onMessage` registers the listener synchronously and subscribes in the
 * background, so a publish that happened immediately after it would race the
 * SUBSCRIBE and be lost — Pub/Sub delivers to whoever is subscribed at the
 * moment of publishing and to nobody else.
 */
function settle(): Promise<void> {
  return pause(200);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  seen: RealtimeMessage[],
  count: number,
): Promise<RealtimeMessage[]> {
  const giveUpAt = Date.now() + ARRIVAL_TIMEOUT_MS;

  while (seen.length < count) {
    if (Date.now() > giveUpAt) {
      throw new Error(
        `Waited ${String(ARRIVAL_TIMEOUT_MS)}ms for ${String(count)} message(s) and saw ${String(
          seen.length,
        )}: ${JSON.stringify(seen)}`,
      );
    }

    await pause(25);
  }

  return seen;
}
