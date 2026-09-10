import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

export interface AiDocumentRecord {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly source: string | null;
  readonly chunkCount: number;
  readonly createdAt: Date;
}

export interface NewChunk {
  readonly ordinal: number;
  readonly content: string;
  readonly embedding: readonly number[];
}

export interface ChunkMatch {
  readonly id: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly source: string | null;
  readonly ordinal: number;
  readonly content: string;
  /**
   * Cosine distance: 0 is identical, 2 is opposite.
   *
   * Distance rather than similarity, because that is what the operator
   * returns and converting it here would put the same number in two shapes.
   */
  readonly distance: number;
}

/**
 * The dimension the `embedding` column is declared with.
 *
 * Exported so a caller can refuse a vector of the wrong length before the
 * database does. `vector(n)` fixes `n` in the column, so changing the embedding
 * model is a migration and a re-embed of everything already stored — the number
 * is here, in the migration, and in the contract, and in no fourth place.
 */
export const EMBEDDING_DIMENSIONS = 1536;

interface RawDocument {
  id: string;
  org_id: string;
  title: string;
  source: string | null;
  chunk_count: bigint;
  created_at: Date;
}

interface RawMatch {
  id: string;
  document_id: string;
  document_title: string;
  source: string | null;
  ordinal: number;
  content: string;
  distance: number;
}

/**
 * Documents, the passages cut from them, and the search over those passages.
 *
 * **Every statement is raw SQL, and the vector is why.** Prisma has no vector
 * type: the column is `Unsupported("vector(1536)")`, which the client can
 * neither read nor write, and the ranking operator has no Prisma expression at
 * all. Declaring it `Float[]` instead would type-check and produce a query that
 * cannot use the index — the worst of both.
 *
 * Row-level security is what keeps one organization's passages out of
 * another's search, and it applies because every call here runs inside a tenant
 * transaction. A vector search that crossed organizations would be the quietest
 * leak in the system: it returns somebody else's text as context, and the model
 * repeats it in an answer that reads as entirely normal.
 */
@Injectable()
export class AiRepository {
  async createDocument(
    orgId: string,
    input: { title: string; source?: string },
  ): Promise<AiDocumentRecord> {
    const rows = await this.client().$queryRaw<RawDocument[]>`
      INSERT INTO "ai_documents" (org_id, title, source)
      VALUES (${orgId}::uuid, ${input.title}, ${input.source ?? null})
      RETURNING id, org_id, title, source, 0::bigint AS chunk_count, created_at`;

    const row = rows[0];

    if (row === undefined) {
      throw new Error(
        'The document was not created: the transaction’s organization does not match.',
      );
    }

    return toDocument(row);
  }

  /**
   * Stores the passages of a document with their vectors.
   *
   * One statement for the whole batch. A row per statement would be a network
   * round trip per passage — a document of two hundred chunks is two hundred
   * of them — and the batch either lands or does not, which is what makes a
   * failed ingest leave no half-searchable document behind.
   */
  async addChunks(
    orgId: string,
    documentId: string,
    chunks: readonly NewChunk[],
  ): Promise<number> {
    if (chunks.length === 0) {
      return 0;
    }

    for (const chunk of chunks) {
      if (chunk.embedding.length !== EMBEDDING_DIMENSIONS) {
        // Refused here rather than by the column, because the column's error
        // names neither the chunk nor the model that produced it — and the
        // usual cause is an embedding model swapped without a migration.
        throw new Error(
          `Chunk ${String(chunk.ordinal)} has ${String(chunk.embedding.length)} dimensions and ` +
            `the column holds ${String(EMBEDDING_DIMENSIONS)}. Changing the embedding model ` +
            'is a migration and a re-embed, not a configuration change.',
        );
      }
    }

    const values = Prisma.join(
      chunks.map(
        (chunk) => Prisma.sql`(
          ${orgId}::uuid,
          ${documentId}::uuid,
          ${chunk.ordinal},
          ${chunk.content},
          ${vectorLiteral(chunk.embedding)}::vector)`,
      ),
    );

    return this.client().$executeRaw`
      INSERT INTO "ai_chunks" (org_id, document_id, ordinal, content, embedding)
      VALUES ${values}`;
  }

  /** This organization's documents, newest first, with how many pieces each holds. */
  async listDocuments(
    orgId: string,
    limit: number,
  ): Promise<AiDocumentRecord[]> {
    const rows = await this.client().$queryRaw<RawDocument[]>`
      SELECT d.id, d.org_id, d.title, d.source, d.created_at,
             COUNT(c.id) AS chunk_count
        FROM "ai_documents" d
        LEFT JOIN "ai_chunks" c ON c.document_id = d.id
       WHERE d.org_id = ${orgId}::uuid
       GROUP BY d.id
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ${limit}`;

    return rows.map(toDocument);
  }

  /** Removes a document; its chunks go with it, by the cascade. */
  async removeDocument(orgId: string, id: string): Promise<boolean> {
    const removed = await this.client().$executeRaw`
      DELETE FROM "ai_documents"
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`;

    return removed > 0;
  }

  /**
   * The passages nearest a question, nearest first.
   *
   * `<=>` is cosine distance, and it is the operator the index was built for.
   * `<->` here would return the same rows in a different order and do it with a
   * sequential scan, silently — the operator class and the operator in the
   * query have to agree.
   *
   * `org_id` is in the predicate as well as in the policy. The policy is what
   * makes it safe; the predicate is what lets the planner use the index that
   * leads with it, rather than ranking every organization's passages and
   * filtering afterwards.
   */
  async search(
    orgId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<ChunkMatch[]> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `The question was embedded into ${String(embedding.length)} dimensions and the column ` +
          `holds ${String(EMBEDDING_DIMENSIONS)}.`,
      );
    }

    const query = vectorLiteral(embedding);

    const rows = await this.client().$queryRaw<RawMatch[]>`
      SELECT c.id, c.document_id, d.title AS document_title, d.source,
             c.ordinal, c.content,
             (c.embedding <=> ${query}::vector) AS distance
        FROM "ai_chunks" c
        JOIN "ai_documents" d ON d.id = c.document_id
       WHERE c.org_id = ${orgId}::uuid
       ORDER BY c.embedding <=> ${query}::vector
       LIMIT ${limit}`;

    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      source: row.source,
      ordinal: row.ordinal,
      content: row.content,
      distance: Number(row.distance),
    }));
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'Documents and passages are read and written inside a tenant transaction. ' +
          'Wrap the call in withTenantTransaction(context, ...).',
      );
    }

    return active.client;
  }
}

/**
 * A vector as pgvector's text form.
 *
 * Passed as a parameter and cast, never interpolated: the numbers come from a
 * model rather than from a caller, but a literal built by string concatenation
 * is a habit that survives into places where they do not.
 */
function vectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

function toDocument(row: RawDocument): AiDocumentRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    source: row.source,
    chunkCount: Number(row.chunk_count),
    createdAt: row.created_at,
  };
}
