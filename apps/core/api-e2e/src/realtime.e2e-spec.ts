import { io, type Socket } from 'socket.io-client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const ORIGIN = 'http://localhost:4200';

let sequence = 0;

interface Member {
  cookie: string;
  orgId: string;
}

interface StreamEvent {
  readonly type: string;
  readonly data: string;
}

/** How long an event has to arrive before a test gives up on it. */
const ARRIVAL_TIMEOUT_MS = 10_000;

/** Where the socket server listens. Under `/api`, like everything else. */
const SOCKET_PATH = '/api/realtime/socket.io';

/**
 * The realtime stream, against the running service.
 *
 * What is checked here is the half that only exists end to end: that an
 * ordinary `GET` really does stay open, that a write on the request path
 * reaches it, and that the room is the session's rather than anything the
 * client asked for. Cross-instance delivery is the bus's own suite, against a
 * real Redis with two instances of the bus — that cannot be observed from
 * here, where there is one API.
 */
describe('realtime', () => {
  let alice: Member;
  let bob: Member;

  beforeAll(async () => {
    alice = await signUpWithOrganisation();
    bob = await signUpWithOrganisation();
  });

  /** Streams this test opened, closed whatever it did. */
  const opened: AbortController[] = [];
  const sockets: Socket[] = [];

  afterEach(() => {
    for (const controller of opened.splice(0)) {
      controller.abort();
    }

    // Not closing these would hold the process open past the last test, and
    // vitest would sit there rather than fail — the slowest possible way to
    // find out a connection leaked.
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
  });

  it('refuses a stream to somebody who is not signed in', async () => {
    const response = await fetch(`${API_URL}/api/v1/realtime/stream`, {
      headers: { origin: ORIGIN },
    });

    // A stream held open with no identity is a stream somebody will eventually
    // put something on.
    expect(response.status).toBe(403);

    await response.body?.cancel();
  });

  it('carries a write on the request path to a stream already open', async () => {
    const events = await openStream(alice);

    const title = `Realtime ${String((sequence += 1))}`;
    await createNote(alice, title);

    const created = await waitForEvent(events, 'note.created');

    expect(JSON.parse(created.data)).toMatchObject({
      name: 'note.created',
      data: { title },
    });
  });

  it('never carries one organization’s write to another’s stream', async () => {
    const bobsStream = await openStream(bob);

    await createNote(alice, `Alice only ${String((sequence += 1))}`);

    // Long enough for it to have arrived if the room meant nothing. The room
    // comes from Bob's session, so there is no request Bob could make that
    // would put him in Alice's.
    await pause(1_500);

    expect(bobsStream.seen.map((event) => event.type)).not.toContain(
      'note.created',
    );
  });

  it('sends only the events a subscriber asked for', async () => {
    const events = await openStream(alice, 'file.ready');

    await createNote(alice, `Filtered ${String((sequence += 1))}`);
    await pause(1_500);

    // A filter, never a permission: it saves bytes on the wire and decides
    // nothing about what may be seen.
    expect(events.seen.map((event) => event.type)).not.toContain(
      'note.created',
    );
  });

  it('carries the same write to a socket, in the room the session decides', async () => {
    const socket = await connect(alice);
    const arrived: { title?: string }[] = [];

    socket.on('note.created', (payload: { data: { title?: string } }) => {
      arrived.push(payload.data);
    });

    const title = `Socket ${String((sequence += 1))}`;
    await createNote(alice, title);

    await waitUntil(
      () => arrived.some((note) => note.title === title),
      `a socket event for "${title}"`,
    );
  });

  it('refuses a socket with no session', async () => {
    const socket = io(API_URL, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      // No cookie. A socket held open with no identity is a socket somebody
      // will eventually send something on.
      extraHeaders: { origin: ORIGIN },
      reconnection: false,
    });
    sockets.push(socket);

    const refusal = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The socket was neither connected nor refused.'));
      }, ARRIVAL_TIMEOUT_MS);

      socket.on('connect_error', (failure: Error) => {
        clearTimeout(timer);
        resolve(failure.message);
      });

      socket.on('connect', () => {
        clearTimeout(timer);
        reject(new Error('The socket connected without a session.'));
      });
    });

    expect(refusal).toContain('signed-in session');
  });

  it('never carries one organization’s write to another’s socket', async () => {
    const bobsSocket = await connect(bob);
    const arrived: unknown[] = [];

    bobsSocket.onAny(() => arrived.push(true));

    await createNote(alice, `Alice only, again ${String((sequence += 1))}`);
    await pause(1_500);

    expect(arrived).toHaveLength(0);
  });

  async function connect(member: Member): Promise<Socket> {
    const socket = io(API_URL, {
      path: SOCKET_PATH,
      // Websocket only, matching the server. Long-polling would spread one
      // logical connection over several HTTP requests and need sticky sessions
      // at the edge.
      transports: ['websocket'],
      extraHeaders: { cookie: member.cookie, origin: ORIGIN },
      reconnection: false,
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The socket never connected.'));
      }, ARRIVAL_TIMEOUT_MS);

      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (failure: Error) => {
        clearTimeout(timer);
        reject(failure);
      });
    });

    return socket;
  }

  async function waitUntil(
    reached: () => boolean,
    describe: string,
  ): Promise<void> {
    const giveUpAt = Date.now() + ARRIVAL_TIMEOUT_MS;

    while (!reached()) {
      if (Date.now() > giveUpAt) {
        throw new Error(
          `Waited ${String(ARRIVAL_TIMEOUT_MS)}ms for ${describe}.`,
        );
      }

      await pause(50);
    }
  }

  interface OpenStream {
    readonly seen: StreamEvent[];
  }

  async function openStream(
    member: Member,
    names?: string,
  ): Promise<OpenStream> {
    const controller = new AbortController();
    opened.push(controller);

    const query = names === undefined ? '' : `?names=${names}`;
    const response = await fetch(
      `${API_URL}/api/v1/realtime/stream${query}`,
      {
        headers: {
          cookie: member.cookie,
          origin: ORIGIN,
          accept: 'text/event-stream',
        },
        signal: controller.signal,
      },
    );

    if (!response.ok || response.body === null) {
      throw new Error(
        `stream failed: ${String(response.status)} ${await response.text()}`,
      );
    }

    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const seen: StreamEvent[] = [];
    void read(response.body, seen);

    // The stream is open before the write that has to reach it. Without this
    // the note would be created first and the event published to nobody — a
    // race that fails perhaps one run in ten, which is worse than always.
    await pause(300);

    return { seen };
  }

  async function waitForEvent(
    stream: OpenStream,
    type: string,
  ): Promise<StreamEvent> {
    const giveUpAt = Date.now() + ARRIVAL_TIMEOUT_MS;

    for (;;) {
      const found = stream.seen.find((event) => event.type === type);

      if (found !== undefined) {
        return found;
      }

      if (Date.now() > giveUpAt) {
        throw new Error(
          `Waited ${String(ARRIVAL_TIMEOUT_MS)}ms for "${type}" and saw ${JSON.stringify(
            stream.seen.map((event) => event.type),
          )}`,
        );
      }

      await pause(50);
    }
  }
});

/**
 * Reads the frames off a stream until it is aborted.
 *
 * SSE frames are separated by a blank line, and each carries `event:` and
 * `data:` lines. Parsed here rather than with `EventSource`, which cannot send
 * a cookie for another origin and cannot be given headers at all.
 */
async function read(
  body: ReadableStream<Uint8Array>,
  seen: StreamEvent[],
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      buffered += decoder.decode(value, { stream: true });

      let boundary = buffered.indexOf('\n\n');

      while (boundary !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);

        const parsed = parseFrame(frame);

        if (parsed !== undefined) {
          seen.push(parsed);
        }

        boundary = buffered.indexOf('\n\n');
      }
    }
  } catch {
    // The abort in `afterEach` arrives here. There is nothing to report: the
    // test asked for the stream to end.
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): StreamEvent | undefined {
  let type = 'message';
  const data: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trim());
    }
  }

  return data.length === 0 && type === 'message'
    ? undefined
    : { type, data: data.join('\n') };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createNote(member: Member, title: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/v1/notes`, {
    method: 'POST',
    headers: {
      cookie: member.cookie,
      origin: ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body: 'Written to be announced.' }),
  });

  if (!response.ok) {
    throw new Error(
      `note failed: ${String(response.status)} ${await response.text()}`,
    );
  }
}

async function signUp(): Promise<{ cookie: string }> {
  const email = `realtime-${Date.now()}-${(sequence += 1)}@example.com`;
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      email,
      password: 'password123',
      name: 'Realtime User',
    }),
  });

  if (!response.ok) {
    throw new Error(
      `sign-up failed: ${String(response.status)} ${await response.text()}`,
    );
  }

  const cookie = (response.headers.get('set-cookie') ?? '')
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .join('; ');

  return { cookie };
}

async function signUpWithOrganisation(): Promise<Member> {
  const { cookie } = await signUp();

  const created = await fetch(`${API_URL}/api/auth/organization/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({
      name: `Org ${(sequence += 1)}`,
      slug: `realtime-org-${Date.now()}-${sequence}`,
    }),
  });
  const org = (await created.json()) as { id: string };

  await fetch(`${API_URL}/api/auth/organization/set-active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ organizationId: org.id }),
  });

  return { cookie, orgId: org.id };
}
