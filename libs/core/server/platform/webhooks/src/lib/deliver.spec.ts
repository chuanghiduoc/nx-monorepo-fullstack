import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliver } from './deliver.js';
import type { PinnedDestination } from './safe-address.js';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, verify } from './signature.js';

const SECRET = 'a-secret-that-is-long-enough-to-be-one';
const EVENT_ID = '01a06400-0000-7000-8000-000000000001';
const BODY = '{"eventType":"note.created"}';

interface Received {
  body: string;
  headers: IncomingMessage['headers'];
}

/**
 * A delivery against a real HTTP server.
 *
 * The destination is constructed here rather than resolved, which is exactly
 * what splitting `pinDestination` from `deliver` bought: a test server can
 * only listen on loopback, and loopback is what the address guard exists to
 * refuse. The guard has its own suite; this one is the transport, and it can
 * therefore be tested at all.
 */
describe('sending a delivery', () => {
  let server: Server;
  let destination: PinnedDestination;
  let received: Received | undefined;
  let respondWith = { status: 200, body: 'ok', delayMs: 0 };

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        received = { body, headers: request.headers };

        const answer = (): void => {
          response.writeHead(respondWith.status, {
            'content-type': 'text/plain',
          });
          response.end(respondWith.body);
        };

        if (respondWith.delayMs > 0) {
          setTimeout(answer, respondWith.delayMs).unref();
        } else {
          answer();
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address() as AddressInfo;
    destination = {
      url: new URL(`http://127.0.0.1:${port}/hook`),
      address: '127.0.0.1',
      family: 4,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    received = undefined;
    respondWith = { status: 200, body: 'ok', delayMs: 0 };
  });

  const send = (timeoutMs = 2_000) =>
    deliver(destination, {
      secret: SECRET,
      eventId: EVENT_ID,
      body: BODY,
      timeoutMs,
    });

  it('posts the body it was given, unaltered', async () => {
    const outcome = await send();

    expect(outcome.status).toBe(200);
    expect(received?.body).toBe(BODY);
    expect(received?.headers['content-type']).toBe('application/json');
  });

  it('signs it so a receiver holding the secret can verify it', async () => {
    await send();

    const header = received?.headers[SIGNATURE_HEADER];
    expect(typeof header).toBe('string');
    expect(verify(BODY, header as string, SECRET)).toBe(true);
  });

  it('names the event so a receiver can ignore one it has seen', async () => {
    await send();

    // Delivery is at-least-once and cannot be otherwise: no transaction spans
    // this database and somebody else's server. This header is the receiver's
    // half of that bargain.
    expect(received?.headers[EVENT_ID_HEADER]).toBe(EVENT_ID);
  });

  it('reports the status a receiver answered with', async () => {
    respondWith = { status: 503, body: 'busy', delayMs: 0 };

    const outcome = await send();

    expect(outcome.status).toBe(503);
    expect(outcome.error).toBe('busy');
  });

  it('keeps only the beginning of a large error body', async () => {
    respondWith = { status: 500, body: 'x'.repeat(5_000), delayMs: 0 };

    const outcome = await send();

    // A receiver that answers a webhook with a megabyte of HTML must not be
    // able to fill this process's memory, or the delivery log's column.
    expect((outcome.error ?? '').length).toBeLessThanOrEqual(200);
  });

  it('does not record an error body for a success', async () => {
    const outcome = await send();

    expect(outcome.error).toBeUndefined();
  });

  it('gives up on a receiver that accepts and never answers', async () => {
    respondWith = { status: 200, body: 'ok', delayMs: 5_000 };

    const outcome = await send(300);

    // Without the timeout this promise outlives the job's own deadline, and
    // the worker holds a connection for a receiver that is simply gone.
    expect(outcome.status).toBeUndefined();
    expect(outcome.error).toMatch(/within 300ms|socket hang up|aborted/i);
  });

  it('reports how long it took, for the receiver that is up and slow', async () => {
    respondWith = { status: 200, body: 'ok', delayMs: 150 };

    const outcome = await send();

    expect(outcome.durationMs).toBeGreaterThanOrEqual(140);
  });

  it('reports a refused connection rather than throwing', async () => {
    const closed: PinnedDestination = {
      // Port 1 on loopback: nothing listens there.
      url: new URL('http://127.0.0.1:1/hook'),
      address: '127.0.0.1',
      family: 4,
    };

    const outcome = await deliver(closed, {
      secret: SECRET,
      eventId: EVENT_ID,
      body: BODY,
      timeoutMs: 2_000,
    });

    // An outcome, not an exception: the caller writes a delivery row either
    // way, and a throw here would be the one failure that leaves no record.
    expect(outcome.status).toBeUndefined();
    expect(outcome.error).toMatch(/ECONNREFUSED|refused/i);
  });
});
