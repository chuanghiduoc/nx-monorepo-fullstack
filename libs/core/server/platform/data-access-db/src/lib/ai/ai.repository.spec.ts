import { Client } from 'pg';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import type { TenantScopedContext } from '@workspace/core-server-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import { AiRepository, EMBEDDING_DIMENSIONS } from './ai.repository.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const OTHER_ORG = '0199a1b2-0000-7000-8000-00000000000b';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';

const CONTEXT: TenantScopedContext = { kind: 'org', orgId: ORG, userId: USER };
const OTHER_CONTEXT: TenantScopedContext = {
  kind: 'org',
  orgId: OTHER_ORG,
  userId: USER,
};

/**
 * A vector pointing almost entirely along one axis.
 *
 * Real embeddings are dense and normalised; these are not, and they do not have
 * to be. What is being tested is that the column round-trips, that the operator
 * ranks nearer before further, and that the policy holds — none of which cares
 * whether the numbers came from a model.
 */
function unitVector(axis: number, lean = 0): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[axis] = 1;

  if (lean !== 0) {
    vector[(axis + 1) % EMBEDDING_DIMENSIONS] = lean;
  }

  return vector;
}

/**
 * Documents and passages, against a real PostgreSQL with pgvector.
 *
 * Real rather than mocked because everything worth testing here is what the
 * database does: whether `vector(1536)` accepts what is handed to it, whether
 * `<=>` ranks the way the index was built for, and whether the policy keeps one
 * organization's passages out of another's search. A double would confirm that
 * a string was built.
 */
describe('documents and passages', () => {
  let postgres: TestPostgres;
  let owner: Client;
  let asApp: PrismaService;
  let appDb: Database;
  let ai: AiRepository;

  const ingest = (
    title: string,
    chunks: { content: string; embedding: number[] }[],
    context = CONTEXT,
  ) =>
    appDb.withTenantTransaction(context, async () => {
      const document = await ai.createDocument(context.orgId ?? ORG, { title });

      await ai.addChunks(
        context.orgId ?? ORG,
        document.id,
        chunks.map((chunk, ordinal) => ({ ...chunk, ordinal })),
      );

      return document;
    });

  const search = (embedding: number[], limit = 5, context = CONTEXT) =>
    appDb.withTenantTransaction(context, () =>
      ai.search(context.orgId ?? ORG, embedding, limit),
    );

  beforeAll(async () => {
    postgres = await startPostgres();

    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    asApp = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await asApp.$connect();

    appDb = new Database(asApp);
    ai = new AiRepository();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await asApp?.$disconnect();
    await owner?.end();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM ai_documents');
  });

  it('stores a vector and gives it back through a search', async () => {
    const vector = unitVector(0);
    await ingest('The handbook', [{ content: 'Holidays are booked here.', embedding: vector }]);

    const [match] = await search(vector);

    expect(match?.content).toBe('Holidays are booked here.');
    expect(match?.documentTitle).toBe('The handbook');
    // Cosine distance to itself. Floating point, so not exactly zero.
    expect(match?.distance).toBeLessThan(0.000_01);
  });

  it('ranks a near passage above a far one', async () => {
    await ingest('Two passages', [
      { content: 'near', embedding: unitVector(0, 0.05) },
      { content: 'far', embedding: unitVector(500) },
    ]);

    const matches = await search(unitVector(0));

    // The whole point of the column and its index. Without an operator that
    // agrees with the index this returns the same rows in an arbitrary order,
    // and nothing says so.
    expect(matches.map((match) => match.content)).toEqual(['near', 'far']);
    expect(matches[0]?.distance).toBeLessThan(matches[1]?.distance ?? 0);
  });

  it('never returns another organization’s passages', async () => {
    const shared = unitVector(0);
    await ingest('Theirs', [{ content: 'a secret', embedding: shared }], OTHER_CONTEXT);
    await ingest('Ours', [{ content: 'ours', embedding: unitVector(900) }]);

    // The same vector the other organization's passage was stored with, which
    // is the strongest form of this question: the row is the nearest match by
    // distance and must still not appear.
    const matches = await search(shared);

    expect(matches.map((match) => match.content)).toEqual(['ours']);
  });

  it('shows one organization nothing of another’s documents', async () => {
    await ingest('Theirs', [{ content: 'x', embedding: unitVector(0) }], OTHER_CONTEXT);

    const listed = await appDb.withTenantTransaction(CONTEXT, () =>
      ai.listDocuments(ORG, 50),
    );

    expect(listed).toEqual([]);
  });

  it('counts the passages a document holds', async () => {
    await ingest('Three', [
      { content: 'a', embedding: unitVector(0) },
      { content: 'b', embedding: unitVector(1) },
      { content: 'c', embedding: unitVector(2) },
    ]);

    const [document] = await appDb.withTenantTransaction(CONTEXT, () =>
      ai.listDocuments(ORG, 50),
    );

    expect(document?.chunkCount).toBe(3);
  });

  it('takes the passages with the document', async () => {
    const document = await ingest('Temporary', [
      { content: 'a', embedding: unitVector(0) },
    ]);

    const removed = await appDb.withTenantTransaction(CONTEXT, () =>
      ai.removeDocument(ORG, document.id),
    );

    expect(removed).toBe(true);
    // The cascade. Orphaned passages would keep answering questions from a
    // document nobody can open.
    expect(await search(unitVector(0))).toEqual([]);
  });

  it('will not delete another organization’s document', async () => {
    const theirs = await ingest(
      'Theirs',
      [{ content: 'x', embedding: unitVector(0) }],
      OTHER_CONTEXT,
    );

    const removed = await appDb.withTenantTransaction(CONTEXT, () =>
      ai.removeDocument(ORG, theirs.id),
    );

    expect(removed).toBe(false);
  });

  it('refuses a vector of the wrong length, naming both numbers', async () => {
    const document = await appDb.withTenantTransaction(CONTEXT, () =>
      ai.createDocument(ORG, { title: 'Mismatched' }),
    );

    // The usual cause is an embedding model swapped without a migration, and
    // the column's own error names neither the chunk nor the model.
    await expect(
      appDb.withTenantTransaction(CONTEXT, () =>
        ai.addChunks(ORG, document.id, [
          { ordinal: 0, content: 'short', embedding: [1, 2, 3] },
        ]),
      ),
    ).rejects.toThrow(/3 dimensions and the column holds 1536/);
  });

  it('refuses a question embedded into the wrong length', async () => {
    await expect(search([1, 2, 3])).rejects.toThrow(/holds 1536/);
  });

  it('writes nothing when one chunk of a batch is wrong', async () => {
    const document = await appDb.withTenantTransaction(CONTEXT, () =>
      ai.createDocument(ORG, { title: 'Partly wrong' }),
    );

    await expect(
      appDb.withTenantTransaction(CONTEXT, () =>
        ai.addChunks(ORG, document.id, [
          { ordinal: 0, content: 'fine', embedding: unitVector(0) },
          { ordinal: 1, content: 'wrong', embedding: [1] },
        ]),
      ),
    ).rejects.toThrow();

    // A half-ingested document answers questions from part of itself and gives
    // no sign that the rest is missing.
    expect(await search(unitVector(0))).toEqual([]);
  });

  it('refuses two passages at the same position in one document', async () => {
    const document = await appDb.withTenantTransaction(CONTEXT, () =>
      ai.createDocument(ORG, { title: 'Twice' }),
    );

    await expect(
      appDb.withTenantTransaction(CONTEXT, () =>
        ai.addChunks(ORG, document.id, [
          { ordinal: 0, content: 'first', embedding: unitVector(0) },
          { ordinal: 0, content: 'again', embedding: unitVector(1) },
        ]),
      ),
      // A re-ingest that wrote the same ordinal twice would return the same
      // passage twice, as though two sources agreed with each other.
    ).rejects.toThrow();
  });

  it('refuses to run outside a transaction, and says what to do', async () => {
    await expect(ai.listDocuments(ORG, 10)).rejects.toThrow(
      /withTenantTransaction/,
    );
  });
});
