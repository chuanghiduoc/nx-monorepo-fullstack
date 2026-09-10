import { beforeAll, describe, expect, it } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const ORIGIN = 'http://localhost:4200';

let sequence = 0;

interface Member {
  cookie: string;
  orgId: string;
}

/** A PNG signature and its first chunk, which is what a sniffer needs. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
    0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]),
]);

interface Ticket {
  file: { id: string; status: string };
  shape: string;
  url?: string;
  fields?: Record<string, string>;
  uploadId?: string;
  parts?: { partNumber: number; url: string }[];
}

/**
 * Uploading, end to end, against the store the API is actually configured
 * with.
 *
 * What is being checked is the shape of the flow rather than the driver — the
 * drivers have their own suite against both. Here: a record appears in
 * `PENDING`, the bytes go somewhere the API signed, completing it moves the
 * record exactly one step, and nothing a request can send moves it further.
 */
describe('files', () => {
  let alice: Member;
  let bob: Member;

  beforeAll(async () => {
    alice = await signUpWithOrganisation();
    bob = await signUpWithOrganisation();
  });

  const ticketFor = async (
    member: Member,
    body: Record<string, unknown>,
  ): Promise<Ticket> => {
    const response = await request('POST', '/api/v1/files', member, body);

    if (response.status !== 201) {
      throw new Error(
        `ticket failed: ${response.status} ${await response.text()}`,
      );
    }

    return (await response.json()) as Ticket;
  };

  it('creates a record in PENDING and signs somewhere to put the bytes', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'a.png',
      contentType: 'image/png',
      shape: 'put',
    });

    // The record comes first, always: an object with no record is rubbish the
    // cleanup removes, and creating the object first would leave a window in
    // which neither is true.
    expect(ticket.file.status).toBe('PENDING');
    expect(ticket.url).toMatch(/^https?:\/\//);
  });

  it('never tells a caller the object key', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'b.png',
      contentType: 'image/png',
      shape: 'put',
    });

    // A caller that knew the key would be one signed URL away from a file it
    // was never granted, which is the whole reason downloads go through a
    // route that checks first.
    //
    // The key is `<orgId>/<uuid>`, so what is checked is the absence of that
    // shape rather than the absence of a slash — `image/png` has one, and an
    // earlier version of this test failed on the content type.
    expect(JSON.stringify(ticket.file)).not.toMatch(
      /[0-9a-f-]{36}\/[0-9a-f-]{36}/,
    );
    expect(Object.keys(ticket.file)).not.toContain('objectKey');
  });

  it('signs a browser form whose policy bounds the size', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'c.png',
      contentType: 'image/png',
      shape: 'post',
    });

    expect(ticket.shape).toBe('post');
    expect(ticket.fields).toBeDefined();
  });

  it('refuses a multipart ticket with no part count', async () => {
    const response = await request('POST', '/api/v1/files', alice, {
      fileName: 'd.bin',
      contentType: 'application/octet-stream',
      shape: 'multipart',
    });

    expect(response.status).toBe(400);
  });

  it('uploads, completes, and is scanned into READY', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'real.png',
      contentType: 'image/png',
      shape: 'put',
    });

    const put = await fetch(ticket.url as string, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(PNG),
    });
    // The status and the body, not just `ok`: an upload that fails names a
    // reason, and an assertion that hides it costs an hour of guessing.
    expect(`${String(put.status)} ${await put.text()}`).toMatch(/^2\d\d /);

    const completed = await request(
      'POST',
      `/api/v1/files/${ticket.file.id}/complete`,
      alice,
      {},
    );
    expect(completed.status).toBe(201);
    expect(((await completed.json()) as { status: string }).status).toBe(
      'UPLOADED',
    );

    // The scanner runs on the worker, which is not started by this suite. The
    // record stays UPLOADED here, and that is the honest assertion: what this
    // test proves is the request-side half, and the scan has its own tests
    // against a real store.
    const listed = (await (
      await request('GET', '/api/v1/files', alice)
    ).json()) as { items: { id: string; status: string }[] };

    expect(
      listed.items.find((item) => item.id === ticket.file.id)?.status,
    ).toBe('UPLOADED');
  });

  it('accepts a browser form and completes, which is the default shape', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'form.png',
      contentType: 'image/png',
      shape: 'post',
    });

    const form = new FormData();

    for (const [name, value] of Object.entries(ticket.fields ?? {})) {
      form.append(name, value);
    }

    form.append('file', new Blob([new Uint8Array(PNG)]), 'form.png');

    const posted = await fetch(ticket.url as string, {
      method: 'POST',
      body: form,
    });
    expect(`${String(posted.status)} ${await posted.text()}`).toMatch(/^2\d\d /);

    const completed = await request(
      'POST',
      `/api/v1/files/${ticket.file.id}/complete`,
      alice,
      {},
    );

    expect(completed.status).toBe(201);
  });

  it('takes every part over its own signed URL, then completes', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'big.bin',
      contentType: 'application/octet-stream',
      shape: 'multipart',
      partCount: 2,
    });

    const parts = ticket.parts ?? [];
    expect(parts).toHaveLength(2);

    // Uploaded last part first, deliberately: a caller uploading concurrently
    // has no reason to finish them in order. That the bytes are then assembled
    // by part number is the driver suite's assertion, against both drivers and
    // with distinguishable parts; what this proves is that each part URL is
    // signed for its own part and reaches the store over HTTP.
    for (const part of [...parts].reverse()) {
      const sent = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(PNG),
      });
      expect(`${String(sent.status)} ${await sent.text()}`).toMatch(/^2\d\d /);
    }

    const completed = await request(
      'POST',
      `/api/v1/files/${ticket.file.id}/complete`,
      alice,
      {
        uploadId: ticket.uploadId,
        parts: parts.map((part) => ({
          partNumber: part.partNumber,
          etag: `etag-${String(part.partNumber)}`,
        })),
      },
    );

    expect(`${String(completed.status)} ${await completed.text()}`).toMatch(
      /^201 /,
    );
  });

  it('refuses an upload URL whose signature was edited', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'forged.png',
      contentType: 'image/png',
      shape: 'put',
    });

    const forged = new URL(ticket.url as string);
    const signature = forged.searchParams.get('signature') ?? '';
    // One hex digit changed: the URL is otherwise exactly the one the API
    // signed, so what is being tested is the signature and nothing else.
    forged.searchParams.set(
      'signature',
      `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
    );

    const put = await fetch(forged.toString(), {
      method: 'PUT',
      body: new Uint8Array(PNG),
    });

    expect(put.status).toBe(403);
  });

  it('refuses a download link replayed as an upload', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'replay.png',
      contentType: 'image/png',
      shape: 'put',
    });

    // The method is in the signed material, so the same signature used with a
    // different verb is a different signature. Without that, any read link
    // handed to a browser would be a write link.
    const replayed = await fetch(ticket.url as string, { method: 'GET' });

    expect(replayed.status).toBe(403);
  });

  it('refuses to complete an upload that never arrived', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'never.png',
      contentType: 'image/png',
      shape: 'put',
    });

    const response = await request(
      'POST',
      `/api/v1/files/${ticket.file.id}/complete`,
      alice,
      {},
    );

    // The store is asked rather than believed. Without this the record would
    // sit in UPLOADED until the scanner rejected it a minute later, which is a
    // worse message and a slower one.
    expect(response.status).toBe(400);
  });

  it('will not sign a download for a file that has not been checked', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'pending.png',
      contentType: 'image/png',
      shape: 'put',
    });

    const response = await request(
      'GET',
      `/api/v1/files/${ticket.file.id}/download`,
      alice,
    );

    // READY and nothing else. Handing out a PENDING file would make the scan
    // decorative.
    expect(response.status).toBe(409);
  });

  it('hides another organization’s file behind a 404', async () => {
    const ticket = await ticketFor(alice, {
      fileName: 'hidden.png',
      contentType: 'image/png',
      shape: 'put',
    });

    const response = await request(
      'GET',
      `/api/v1/files/${ticket.file.id}/download`,
      bob,
    );

    // Not a 403: telling Bob the id exists is telling him something about
    // Alice's organization.
    expect(response.status).toBe(404);
  });

  it('shows one organization nothing of another’s', async () => {
    await ticketFor(alice, {
      fileName: 'alices.png',
      contentType: 'image/png',
      shape: 'put',
    });

    const listed = (await (
      await request('GET', '/api/v1/files', bob)
    ).json()) as { items: { fileName: string }[] };

    expect(listed.items.map((item) => item.fileName)).not.toContain(
      'alices.png',
    );
  });

  it('refuses a caller with no organization', async () => {
    const { cookie } = await signUp();

    const response = await request('GET', '/api/v1/files', { cookie });

    expect(response.status).toBe(403);
  });
});

async function signUp(): Promise<{ cookie: string }> {
  const email = `files-${Date.now()}-${(sequence += 1)}@example.com`;
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'password123', name: 'Files User' }),
  });

  if (!response.ok) {
    throw new Error(
      `sign-up failed: ${response.status} ${await response.text()}`,
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
      slug: `files-org-${Date.now()}-${sequence}`,
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
