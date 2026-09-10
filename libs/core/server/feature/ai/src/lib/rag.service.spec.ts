import { AiService } from '@workspace/core-server-ai';
import { AuthzService, type Principal } from '@workspace/core-server-authz';
import type { AppConfig } from '@workspace/core-server-core';
import type {
  AiRepository,
  ChunkMatch,
  Database,
} from '@workspace/core-server-data-access-db';
import { describe, expect, it, vi } from 'vitest';

import { PASSAGE_CHARACTERS, PASSAGE_OVERLAP, intoPassages } from './chunking.js';
import { RagService } from './rag.service.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const SEARCH_LIMIT = 5;

const MEMBER: Principal = {
  type: 'user',
  id: 'user-1',
  orgId: ORG,
  roles: ['owner'],
} as Principal;

const rolePermissions = {
  owner: { note: ['create', 'read', 'delete'] },
  reader: { note: ['read'] },
};

/**
 * The service with everything slow replaced.
 *
 * The transaction runs its callback as-is: what these tests are about is the
 * order of the steps, and a real transaction would only add a database. What
 * the database does with a vector is proven against a real PostgreSQL in the
 * repository's own suite; what the SDK does with usage is proven against its
 * mock models in the facade's.
 */
function serviceWith(options: {
  matches?: ChunkMatch[];
  onEmbed?: () => void;
  onSearch?: () => void;
}) {
  // How many transactions are open right now. A provider call is supposed to
  // happen with none, and counting is the only way a test can tell — the
  // callback runs either way, so asserting on the order it ran in proves
  // nothing about what was open while it did.
  let depth = 0;

  const inTransaction = vi.fn(async <T>(...args: unknown[]) => {
    const work = args[args.length - 1] as () => Promise<T>;
    depth += 1;
    try {
      return await work();
    } finally {
      depth -= 1;
    }
  });

  const db = {
    withRequestTransaction: inTransaction,
    withTenantTransaction: inTransaction,
  } as unknown as Database;

  const createDocument = vi.fn().mockResolvedValue({
    id: 'doc-1',
    orgId: ORG,
    title: 'A document',
    source: null,
    chunkCount: 0,
    createdAt: new Date(),
  });
  const addChunks = vi.fn().mockResolvedValue(0);
  const search = vi.fn(async () => {
    options.onSearch?.();
    return options.matches ?? [];
  });

  const documents = {
    createDocument,
    addChunks,
    search,
    listDocuments: vi.fn().mockResolvedValue([]),
    removeDocument: vi.fn().mockResolvedValue(true),
  } as unknown as AiRepository;

  const embedAll = vi.fn(async (_purpose: string, values: readonly string[]) => {
    options.onEmbed?.();
    return values.map(() => [0.1, 0.2, 0.3]);
  });

  const stream = vi.fn(
    async (
      _request: unknown,
      onText: (delta: string) => void,
    ): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
      onText('an ');
      onText('answer');
      return { text: 'an answer', inputTokens: 11, outputTokens: 22 };
    },
  );

  const ai = { embedAll, stream } as unknown as AiService;

  const config = {
    get: (key: string) => (key === 'AI_SEARCH_LIMIT' ? SEARCH_LIMIT : undefined),
  } as unknown as AppConfig;

  return {
    rag: new RagService(
      db,
      documents,
      ai,
      new AuthzService(rolePermissions),
      config,
    ),
    createDocument,
    addChunks,
    embedAll,
    search,
    stream,
    openTransactions: () => depth,
  };
}

describe('cutting a document up', () => {
  it('leaves a short document in one piece', () => {
    expect(intoPassages('a short note')).toEqual(['a short note']);
  });

  it('drops a document that is only whitespace', () => {
    // Embedding it would cost a request and return a vector near everything,
    // which is worse than not having it.
    expect(intoPassages('   \n\t  ')).toEqual([]);
  });

  it('overlaps each passage with the one before it', () => {
    const text = 'x'.repeat(PASSAGE_CHARACTERS * 2);
    const passages = intoPassages(text);

    expect(passages.length).toBeGreaterThan(1);
    // A sentence straddling a boundary would otherwise be in neither passage
    // in one piece, and the answer that needed it retrieves half of it.
    expect(passages[0]?.length).toBe(PASSAGE_CHARACTERS);
    expect(passages.length).toBe(
      Math.ceil(
        (PASSAGE_CHARACTERS * 2 - PASSAGE_OVERLAP) /
          (PASSAGE_CHARACTERS - PASSAGE_OVERLAP),
      ),
    );
  });

  it('does not end with a passage that is entirely overlap', () => {
    const text = 'y'.repeat(PASSAGE_CHARACTERS + 10);
    const passages = intoPassages(text);

    // The same text embedded twice would be retrieved twice, as though two
    // sources agreed with each other.
    expect(new Set(passages).size).toBe(passages.length);
  });
});

describe('ingesting', () => {
  it('embeds every passage in one call', async () => {
    const { rag, embedAll } = serviceWith({});

    await rag.ingest(MEMBER, ORG, {
      title: 'A document',
      text: 'z'.repeat(PASSAGE_CHARACTERS * 3),
    });

    // One request rather than one per passage: a document of two hundred
    // pieces would otherwise be two hundred round trips.
    expect(embedAll).toHaveBeenCalledTimes(1);
  });

  it('embeds with no transaction open', async () => {
    let openWhileEmbedding = -1;
    const service = serviceWith({
      onEmbed: () => {
        openWhileEmbedding = service.openTransactions();
      },
    });

    await service.rag.ingest(MEMBER, ORG, {
      title: 'A document',
      text: 'hello',
    });

    // A provider that takes four seconds must not hold a database connection
    // for four seconds. At any concurrency worth having, that is the pool gone
    // — and Prisma closes an interactive transaction after five, so the write
    // that followed a slow embedding would fail on a transaction that had
    // already gone.
    //
    // The previous version of this test collected one label into an array and
    // asserted it was first, which it was however the code was written.
    expect(openWhileEmbedding).toBe(0);
  });

  it('refuses a document with nothing in it', async () => {
    const { rag, createDocument } = serviceWith({});

    await expect(
      rag.ingest(MEMBER, ORG, { title: 'Empty', text: '   ' }),
    ).rejects.toThrow(/nothing to ingest/);

    expect(createDocument).not.toHaveBeenCalled();
  });

  it('refuses without the permission, and reaches no provider', async () => {
    const { rag, embedAll } = serviceWith({});
    const reader = { ...MEMBER, roles: ['reader'] } as Principal;

    await expect(
      rag.ingest(reader, ORG, { title: 'A document', text: 'hello' }),
    ).rejects.toThrow();

    // Permission before work, and before money.
    expect(embedAll).not.toHaveBeenCalled();
  });
});

describe('asking', () => {
  const match = (content: string, distance: number): ChunkMatch => ({
    id: 'chunk-1',
    documentId: 'doc-1',
    documentTitle: 'A document',
    source: null,
    ordinal: 0,
    content,
    distance,
  });

  it('knows the citations before a token is generated', async () => {
    const { rag, stream } = serviceWith({ matches: [match('a passage', 0.1)] });

    const retrieved = await rag.prepare(MEMBER, ORG, 'what?');

    // They come from the search, so the route can send them before it asks for
    // a single token — and a reader sees where an answer is coming from while
    // it is still arriving.
    expect(retrieved.citations).toHaveLength(1);
    expect(stream).not.toHaveBeenCalled();
  });

  it('refuses in prepare, where a refusal can still be a status code', async () => {
    const { rag, embedAll } = serviceWith({ matches: [] });
    const outsider = { ...MEMBER, roles: [] } as Principal;

    // Once a stream is open the status line is already sent, and a caller
    // waiting on an event that never comes cannot tell that from a slow model.
    await expect(rag.prepare(outsider, ORG, 'what?')).rejects.toThrow();
    expect(embedAll).not.toHaveBeenCalled();
  });

  it('asks no model when the search found nothing', async () => {
    const { rag, stream } = serviceWith({ matches: [] });

    const retrieved = await rag.prepare(MEMBER, ORG, 'what?');
    const answer = await rag.answer(retrieved, () => undefined);

    // A model given no passages answers from its own memory and sounds exactly
    // as confident, which is the failure this whole shape exists to avoid.
    expect(stream).not.toHaveBeenCalled();
    expect(answer.text).toMatch(/nothing in this organization/);
  });

  it('returns the tokens the answer cost', async () => {
    const { rag } = serviceWith({ matches: [match('a passage', 0.1)] });

    const retrieved = await rag.prepare(MEMBER, ORG, 'what?');
    const answer = await rag.answer(retrieved, () => undefined);

    expect(answer.inputTokens).toBe(11);
    expect(answer.outputTokens).toBe(22);
  });

  it('streams the text a piece at a time', async () => {
    const deltas: string[] = [];
    const { rag } = serviceWith({ matches: [match('a passage', 0.1)] });

    const retrieved = await rag.prepare(MEMBER, ORG, 'what?');
    await rag.answer(retrieved, (delta) => deltas.push(delta));

    expect(deltas).toEqual(['an ', 'answer']);
  });

  it('numbers the passages it gives the model', async () => {
    const { rag, stream } = serviceWith({
      matches: [match('first passage', 0.1), match('second passage', 0.2)],
    });

    const retrieved = await rag.prepare(MEMBER, ORG, 'what?');
    await rag.answer(retrieved, () => undefined);

    const [request] = stream.mock.calls[0] as unknown as [
      { prompt: string; system?: string },
    ];

    // Numbered so the model can cite them and a reader can check the citation
    // against the list the response already carried.
    expect(request.prompt).toContain('[1] A document');
    expect(request.prompt).toContain('[2] A document');
    expect(request.prompt).toContain('Question: what?');
    expect(request.system).toMatch(/only the passages provided/);
  });

  it('asks for as many passages as the configuration says', async () => {
    const { rag, search } = serviceWith({ matches: [] });

    await rag.prepare(MEMBER, ORG, 'what?');

    expect(search).toHaveBeenCalledWith(ORG, [0.1, 0.2, 0.3], SEARCH_LIMIT);
  });
});
