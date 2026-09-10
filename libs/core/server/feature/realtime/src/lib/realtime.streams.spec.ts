import { ForbiddenException } from '@nestjs/common';
import type { Principal } from '@workspace/core-server-authz';
import {
  RealtimeBus,
  roomFor,
  type RealtimeMessage,
} from '@workspace/core-server-realtime';
import { describe, expect, it } from 'vitest';

import { audienceFor } from './realtime.audience.js';
import { namesFrom } from './realtime.dto.js';
import { RealtimeStreams } from './realtime.streams.js';

/**
 * A bus that publishes nowhere and hands its listener straight back.
 *
 * What is worth testing here is the bookkeeping — which stream gets which
 * message, and whether anything is left behind afterwards. Whether a message
 * crosses Redis is the bus's own suite, against a real one.
 */
function busWithHandle(): {
  bus: RealtimeBus;
  emit: (message: RealtimeMessage) => void;
  registered: () => number;
} {
  const listeners = new Set<(message: RealtimeMessage) => void>();

  const bus = {
    onMessage(listener: (message: RealtimeMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RealtimeBus;

  return {
    bus,
    emit: (message) => {
      for (const listener of listeners) {
        listener(message);
      }
    },
    registered: () => listeners.size,
  };
}

function message(room: string, name: string): RealtimeMessage {
  return { room, name, data: {}, at: new Date().toISOString() };
}

describe('RealtimeStreams', () => {
  it('registers one listener on the bus, however many streams it holds', () => {
    const { bus, registered } = busWithHandle();
    const streams = new RealtimeStreams(bus);
    streams.onModuleInit();

    for (let index = 0; index < 10; index += 1) {
      streams.subscribe('org:a', [], () => undefined);
    }

    // One, not ten. With a listener per client the room check would live in as
    // many places as there are clients, and every message would be offered to
    // every one of them.
    expect(registered()).toBe(1);
  });

  it('delivers only to the room the message names', () => {
    const { bus, emit } = busWithHandle();
    const streams = new RealtimeStreams(bus);
    streams.onModuleInit();

    const mine: string[] = [];
    const theirs: string[] = [];
    streams.subscribe('org:a', [], (event) => mine.push(event.name));
    streams.subscribe('org:b', [], (event) => theirs.push(event.name));

    emit(message('org:a', 'note.created'));

    expect(mine).toEqual(['note.created']);
    expect(theirs).toEqual([]);
  });

  it('applies the name filter inside the room', () => {
    const { bus, emit } = busWithHandle();
    const streams = new RealtimeStreams(bus);
    streams.onModuleInit();

    const seen: string[] = [];
    streams.subscribe('org:a', ['file.ready'], (event) => seen.push(event.name));

    emit(message('org:a', 'note.created'));
    emit(message('org:a', 'file.ready'));

    expect(seen).toEqual(['file.ready']);
  });

  it('sends everything when the subscriber named nothing', () => {
    const { bus, emit } = busWithHandle();
    const streams = new RealtimeStreams(bus);
    streams.onModuleInit();

    const seen: string[] = [];
    streams.subscribe('org:a', [], (event) => seen.push(event.name));

    emit(message('org:a', 'note.created'));

    // A subscriber that named nothing wants the stream, not silence.
    expect(seen).toEqual(['note.created']);
  });

  it('forgets the room once its last stream has gone', () => {
    const { bus } = busWithHandle();
    const streams = new RealtimeStreams(bus);
    streams.onModuleInit();

    const off = streams.subscribe('org:a', [], () => undefined);
    expect(streams.countIn('org:a')).toBe(1);

    off();

    // Not merely empty: gone. A service that has seen a million organizations
    // would otherwise hold a million empty sets — a leak that grows with
    // traffic rather than with connections, which is the harder one to notice.
    expect(streams.countIn('org:a')).toBe(0);
  });

  it('survives a stream that unsubscribes itself while being delivered to', () => {
    const { bus, emit } = busWithHandle();
    const streams = new RealtimeStreams(bus);
    streams.onModuleInit();

    const seen: string[] = [];
    const first = streams.subscribe('org:a', [], () => {
      first();
    });
    streams.subscribe('org:a', [], (event) => seen.push(event.name));

    emit(message('org:a', 'note.created'));

    // An SSE stream whose client has gone does exactly this. Iterating the
    // live `Set` would silently skip the entry after it.
    expect(seen).toEqual(['note.created']);
  });

  it('takes its listener off the bus when the module is torn down', () => {
    const { bus, registered } = busWithHandle();
    const streams = new RealtimeStreams(bus);

    streams.onModuleInit();
    expect(registered()).toBe(1);

    streams.onModuleDestroy();
    expect(registered()).toBe(0);
  });
});

describe('audienceFor', () => {
  it('puts a member in their organization’s room', () => {
    const principal = {
      type: 'user',
      id: 'user-1',
      orgId: 'org-1',
      roles: ['member'],
    } as Principal;

    expect(roomFor(audienceFor(principal))).toBe('org:org-1');
  });

  it('gives somebody with no organization a room of their own', () => {
    const principal = { type: 'user', id: 'user-1', roles: [] } as Principal;

    // Not "no tenant": they are a tenant of one, themselves.
    expect(roomFor(audienceFor(principal))).toBe('user:user-1');
  });

  it('follows the key’s issuer, not the key', () => {
    const principal = {
      type: 'apiKey',
      id: 'key-1',
      issuerId: 'user-9',
      permissions: {},
    } as Principal;

    expect(roomFor(audienceFor(principal))).toBe('user:user-9');
  });

  it('refuses a system principal', () => {
    // A relay or a scheduler publishes; it does not subscribe, and a room
    // meaning "everybody" would mean "every organization at once".
    expect(() => audienceFor({ type: 'system', id: 'relay' } as Principal)).toThrow(
      ForbiddenException,
    );
  });
});

describe('namesFrom', () => {
  it('reads a comma-separated list and trims it', () => {
    expect(namesFrom({ names: ' note.created , file.ready ' })).toEqual([
      'note.created',
      'file.ready',
    ]);
  });

  it('treats an absent or empty list as everything', () => {
    expect(namesFrom({})).toEqual([]);
    expect(namesFrom({ names: ' , , ' })).toEqual([]);
  });

  it('bounds how many names one subscriber may filter on', () => {
    const many = Array.from({ length: 100 }, (_, index) => `e${String(index)}`);

    // The list arrives in a query string, and an unbounded one is an
    // unbounded array built per connection.
    expect(namesFrom({ names: many.join(',') })).toHaveLength(32);
  });
});
