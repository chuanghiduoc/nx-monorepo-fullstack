import { beforeAll, describe, expect, it } from 'vitest';

import {
  STUB_ANSWER_PIECES,
  STUB_INPUT_TOKENS,
  STUB_OUTPUT_TOKENS,
} from './model-stub.js';

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

/**
 * The assistant, end to end, against a provider that answers from this process.
 *
 * The provider is a stub speaking the OpenAI wire format — the real SDK, the
 * real HTTP transport, the real route — because the alternatives were a suite
 * that reaches a real provider (slow, flaky, expensive, impossible in CI
 * without a key) or no proof at all that an answer ever arrives over SSE.
 *
 * What the facade does with usage is proven against the SDK's mock models in
 * its own suite; what the database does with a vector is proven against a real
 * PostgreSQL in the repository's. What only exists here is the whole path:
 * ingest, embed, store, search, stream.
 */
describe('the assistant', () => {
  let alice: Member;
  let bob: Member;

  beforeAll(async () => {
    alice = await signUpWithOrganisation();
    bob = await signUpWithOrganisation();
  });

  it('ingests a document and says how many passages it holds', async () => {
    const document = await ingest(alice, {
      title: 'The handbook',
      text: 'Holidays are booked through the portal, at least two weeks ahead.',
    });

    expect(document.chunkCount).toBeGreaterThan(0);
    expect(document.title).toBe('The handbook');
  });

  it('lists what an organization has ingested, and nothing of another’s', async () => {
    await ingest(alice, { title: `Alice's ${String((sequence += 1))}`, text: 'x' });

    const theirs = (await (
      await request('GET', '/api/v1/ai/documents', bob)
    ).json()) as { items: { title: string }[] };

    expect(theirs.items.map((item) => item.title)).not.toContain(
      "Alice's " + String(sequence),
    );
  });

  it('answers over a stream: citations first, then the text, then the cost', async () => {
    await ingest(alice, {
      title: 'Booking holidays',
      source: 'https://example.invalid/handbook',
      text: 'Holidays are booked through the portal.',
    });

    const events = await ask(alice, 'how do I book a holiday');

    const citations = events.find((event) => event.type === 'citations');
    const deltas = events.filter((event) => event.type === 'delta');
    const done = events.find((event) => event.type === 'done');

    // The citations come from the search rather than from the model, so they
    // are known — and sent — before a single token exists.
    expect(events[0]?.type).toBe('citations');
    expect(
      (JSON.parse(citations?.data ?? '[]') as { documentTitle: string }[]).map(
        (citation) => citation.documentTitle,
      ),
    ).toContain('Booking holidays');

    expect(deltas.map((delta) => delta.data).join('')).toBe(
      STUB_ANSWER_PIECES.join(''),
    );

    // The token counts are the provider's, carried all the way out.
    expect(JSON.parse(done?.data ?? '{}')).toEqual({
      inputTokens: STUB_INPUT_TOKENS,
      outputTokens: STUB_OUTPUT_TOKENS,
    });
  });

  it('answers an organization with nothing ingested without asking a model', async () => {
    const empty = await signUpWithOrganisation();

    const events = await ask(empty, 'anything at all');
    const deltas = events.filter((event) => event.type === 'delta');

    // A model given no passages answers from its own memory and sounds exactly
    // as confident, which is the failure the whole shape exists to avoid.
    expect(JSON.parse(events[0]?.data ?? '[]')).toEqual([]);
    expect(deltas).toHaveLength(0);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('never answers one organization from another’s documents', async () => {
    await ingest(alice, {
      title: 'A secret',
      text: 'The launch code is written on the whiteboard.',
    });

    const events = await ask(bob, 'what is the launch code');

    // The strongest form of the question: Bob asks for exactly what Alice
    // ingested, and the search must return nothing.
    expect(JSON.parse(events[0]?.data ?? '[]')).toEqual([]);
  });

  it('removes a document and stops answering from it', async () => {
    const document = await ingest(alice, {
      title: 'Temporary',
      text: 'The fire drill is on the first Tuesday.',
    });

    const removed = await request(
      'DELETE',
      `/api/v1/ai/documents/${document.id}`,
      alice,
    );
    expect(removed.status).toBe(204);

    const events = await ask(alice, 'when is the fire drill');
    const cited = JSON.parse(events[0]?.data ?? '[]') as {
      documentId: string;
    }[];

    // The cascade. Orphaned passages would keep answering from a document
    // nobody can open.
    expect(cited.map((citation) => citation.documentId)).not.toContain(
      document.id,
    );
  });

  it('refuses a caller with no organization', async () => {
    const { cookie } = await signUp();

    const response = await request('GET', '/api/v1/ai/documents', { cookie });

    expect(response.status).toBe(403);
  });

  it('refuses somebody who is not signed in', async () => {
    const response = await fetch(`${API_URL}/api/v1/ai/documents`, {
      headers: { origin: ORIGIN },
    });

    expect(response.status).toBe(403);
  });

  it('refuses a document with no text', async () => {
    const response = await request('POST', '/api/v1/ai/documents', alice, {
      title: 'Empty',
      text: '',
    });

    expect(response.status).toBe(400);
  });

  it('refuses a question with nothing in it', async () => {
    const response = await request('GET', '/api/v1/ai/ask?question=', alice);

    // Refused before the stream opens, which is why it can be a status code at
    // all: everything decided after the first `await` arrives as an event on a
    // 200 instead.
    expect(response.status).toBe(400);
  });
});

async function ingest(
  member: Member,
  body: { title: string; source?: string; text: string },
): Promise<{ id: string; title: string; chunkCount: number }> {
  const response = await request('POST', '/api/v1/ai/documents', member, body);

  if (response.status !== 201) {
    throw new Error(
      `ingest failed: ${String(response.status)} ${await response.text()}`,
    );
  }

  return (await response.json()) as {
    id: string;
    title: string;
    chunkCount: number;
  };
}

/**
 * Asks, and reads the whole stream to its end.
 *
 * Parsed by hand rather than with `EventSource`, which cannot send a cookie for
 * another origin and cannot be given headers at all.
 */
async function ask(member: Member, question: string): Promise<StreamEvent[]> {
  const response = await fetch(
    `${API_URL}/api/v1/ai/ask?question=${encodeURIComponent(question)}`,
    {
      headers: {
        cookie: member.cookie,
        origin: ORIGIN,
        accept: 'text/event-stream',
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `ask failed: ${String(response.status)} ${await response.text()}`,
    );
  }

  const body = await response.text();
  const events: StreamEvent[] = [];

  for (const frame of body.split('\n\n')) {
    let type = 'message';
    const data: string[] = [];

    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        type = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        // Only the leading space is stripped: an answer's whitespace is part of
        // it, and trimming would silently join two words.
        data.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }

    if (data.length > 0) {
      events.push({ type, data: data.join('\n') });
    }
  }

  if (events.some((event) => event.type === 'error')) {
    throw new Error(
      `the stream carried an error: ${JSON.stringify(events)}`,
    );
  }

  return events;
}

async function signUp(): Promise<{ cookie: string }> {
  const email = `ai-${Date.now()}-${(sequence += 1)}@example.com`;
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'password123', name: 'AI User' }),
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
      slug: `ai-org-${Date.now()}-${sequence}`,
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

function request(
  method: string,
  path: string,
  member: { cookie: string },
  body?: unknown,
): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method,
    headers: {
      cookie: member.cookie,
      origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
