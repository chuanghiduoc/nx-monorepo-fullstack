import { describe, expect, it } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const ORIGIN = 'http://localhost:4200';

/**
 * The scrape and the ids, against the running service.
 *
 * What only exists end to end is the part that depends on Fastify: that a route
 * label is the *template* rather than the URL, that a request that matched
 * nothing does not become a label of its own, and that the id on the response
 * is the id the trace uses.
 */
describe('observability', () => {
  it('answers a scrape in the format Prometheus reads', async () => {
    const response = await fetch(`${API_URL}/api/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const text = await response.text();

    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toContain('service="core-api"');
  });

  it('labels a request with its route template, never its URL', async () => {
    const id = `${Date.now()}`;

    // A path with an id in it. If the URL became the label, this would be one
    // time series per request — which is how a metrics backend is destroyed by
    // an application that meant well.
    await fetch(`${API_URL}/api/v1/notes/${id}`, {
      headers: { origin: ORIGIN },
    });

    const text = await (await fetch(`${API_URL}/api/metrics`)).text();

    expect(text).not.toContain(id);
  });

  it('gives a request that matched no route one label, not one each', async () => {
    await fetch(`${API_URL}/api/v1/no-such-route-${String(Date.now())}`);

    const text = await (await fetch(`${API_URL}/api/metrics`)).text();

    expect(text).toContain('route="unmatched"');
  });

  it('carries no identifier in any label it publishes', async () => {
    const text = await (await fetch(`${API_URL}/api/metrics`)).text();

    const labels = new Set<string>();

    for (const match of text.matchAll(/\{([^}]*)\}/g)) {
      for (const pair of (match[1] ?? '').split(',')) {
        const name = pair.split('=')[0]?.trim();
        if (name) {
          labels.add(name);
        }
      }
    }

    // The budget, checked against what the process actually publishes rather
    // than against what the code declares.
    const forbidden = [...labels].filter((label) =>
      /(^|_)(user|org|organisation|organization|email|tenant|token|key)($|_)/i.test(
        label,
      ),
    );

    expect(forbidden).toEqual([]);
  });

  it('publishes the numbers that live in the database and in Redis', async () => {
    const text = await (await fetch(`${API_URL}/api/metrics`)).text();

    // Every state, including the empty ones. A gauge that disappears when its
    // state empties looks identical on a dashboard to one that stopped being
    // collected, and the two need opposite responses.
    expect(text).toMatch(/outbox_rows\{[^}]*state="PENDING"[^}]*\} \d+/);
    expect(text).toMatch(/outbox_rows\{[^}]*state="DEAD"[^}]*\} \d+/);
    expect(text).toMatch(
      /queue_depth\{[^}]*queue="events"[^}]*state="waiting"[^}]*\} \d+/,
    );
    expect(text).toMatch(
      /webhook_deliveries_recent\{[^}]*outcome="unreachable"[^}]*\} \d+/,
    );
  });

  it('answers every request with an id a person can quote', async () => {
    const response = await fetch(`${API_URL}/api`);

    const id = response.headers.get('x-request-id');

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('keeps the id a caller sent, so a trace continues rather than restarting', async () => {
    const sent = '0199a1b2-0000-7000-8000-0000000000ff';

    const response = await fetch(`${API_URL}/api`, {
      headers: { 'x-request-id': sent },
    });

    expect(response.headers.get('x-request-id')).toBe(sent);
  });

  it('puts that id in the problem document when something is refused', async () => {
    const sent = '0199a1b2-0000-7000-8000-0000000000fe';

    const response = await fetch(`${API_URL}/api/v1/notes`, {
      headers: { 'x-request-id': sent, origin: ORIGIN },
    });

    const problem = (await response.json()) as { traceId?: string };

    // One id: the log line, the response header, the problem document and —
    // with the dashes removed — the trace itself.
    expect(problem.traceId).toBe(sent);
  });
});
