import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { pinnedLookup, type PinnedDestination } from './safe-address.js';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, sign } from './signature.js';

export interface DeliveryRequest {
  readonly secret: string;
  readonly eventId: string;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface DeliveryOutcome {
  /** The response's status, or `undefined` when nothing answered. */
  readonly status?: number;
  readonly error?: string;
  readonly durationMs: number;
}

/** How much of a receiver's response body is kept for the log. */
const MAX_ERROR_BODY = 200;

/**
 * Sends one delivery to an address that has already been validated.
 *
 * **It takes a `PinnedDestination`, not a URL, and that is the design.** The
 * validation and the transport are two jobs, and joining them makes the
 * transport untestable — a test server can only listen on loopback, which the
 * validation exists to refuse, so a combined function can only ever be tested
 * on its refusal. Separated, the guard is tested against every range that
 * matters and the transport is tested against a real server.
 *
 * The caller does both, in order:
 *
 * ```ts
 * const destination = await pinDestination(endpoint.url, { requireHttps });
 * const outcome = await deliver(destination, { ... });
 * ```
 *
 * `node:https` rather than `fetch`, and the reason is the whole security
 * argument: `fetch` gives no way to say "connect to *this address*", so a name
 * validated a moment ago is resolved again by the client and the second answer
 * is the one the socket uses. `request({ lookup })` pins it.
 *
 * TLS still verifies the certificate against the **hostname** — the hostname
 * stays in the options and only the socket's destination is pinned — so this
 * does not weaken it. Measured against a real endpoint: `authorized: true`.
 *
 * Redirects are not followed. A `302` to `http://169.254.169.254/` is the
 * whole attack, and re-validating every hop is more code than telling
 * receivers not to redirect; a redirect is reported as the status it is.
 */
export function deliver(
  destination: PinnedDestination,
  delivery: DeliveryRequest,
): Promise<DeliveryOutcome> {
  const startedAt = Date.now();
  const send =
    destination.url.protocol === 'https:' ? httpsRequest : httpRequest;
  const signature = sign(delivery.body, delivery.secret);

  return new Promise<DeliveryOutcome>((resolve) => {
    const outbound = send(
      {
        protocol: destination.url.protocol,
        host: destination.url.hostname,
        ...(destination.url.port === ''
          ? {}
          : { port: Number(destination.url.port) }),
        path: `${destination.url.pathname}${destination.url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(delivery.body),
          [SIGNATURE_HEADER]: signature,
          [EVENT_ID_HEADER]: delivery.eventId,
          'user-agent': 'workspace-webhooks/1',
        },
        // The pin. Everything above names the host, so TLS and the Host header
        // are correct; only the socket's destination is fixed.
        lookup: pinnedLookup(destination),
      },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          // Bounded: a receiver answering a webhook with a megabyte of HTML
          // must not be able to fill this process's memory, and only the first
          // line of it is ever useful.
          if (body.length < MAX_ERROR_BODY) {
            body += chunk;
          }
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({
            status,
            ...(status >= 400
              ? { error: body.slice(0, MAX_ERROR_BODY).trim() }
              : {}),
            durationMs: Date.now() - startedAt,
          });
        });
      },
    );

    outbound.setTimeout(delivery.timeoutMs, () => {
      // `destroy` rather than leaving it: the socket is closed and the `error`
      // handler below resolves. Without it, a receiver that accepts the
      // connection and never answers holds this promise past the job's own
      // deadline.
      outbound.destroy(new Error(`No answer within ${delivery.timeoutMs}ms.`));
    });

    outbound.on('error', (failure: Error) => {
      resolve({
        error: failure.message,
        durationMs: Date.now() - startedAt,
      });
    });

    outbound.end(delivery.body);
  });
}
