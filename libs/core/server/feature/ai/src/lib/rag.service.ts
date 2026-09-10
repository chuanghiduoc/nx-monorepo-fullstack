import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AiService } from '@workspace/core-server-ai';
import { AuthzService, type Principal } from '@workspace/core-server-authz';
import { AppConfig } from '@workspace/core-server-core';
import {
  AiRepository,
  Database,
  type AiDocumentRecord,
  type ChunkMatch,
} from '@workspace/core-server-data-access-db';

import { intoPassages } from './chunking.js';

/** How many documents one page of the listing returns. */
const LIST_LIMIT = 100;

/**
 * What the model is told to do with the passages it is given.
 *
 * Short, and it says what to do when the answer is not there. A model given
 * context and no instruction about its absence answers from what it already
 * knows and sounds exactly as confident either way.
 */
const SYSTEM_PROMPT = [
  'Answer using only the passages provided.',
  'If they do not contain the answer, say so plainly and stop.',
  'Cite the passage numbers you used.',
].join(' ');

export interface Citation {
  readonly documentId: string;
  readonly documentTitle: string;
  readonly source: string | null;
  readonly ordinal: number;
  readonly distance: number;
}

export interface Answer {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Everything decided before a single token is generated.
 *
 * Separate from the answer because every way this can be refused — no
 * permission, no provider configured, no quota left — has to be refused
 * *before* the response starts. Once a stream is open the status line is
 * already sent, and a caller waiting on an event that never comes has no way
 * to tell that from a slow model.
 */
export interface Retrieved {
  readonly citations: readonly Citation[];
  readonly matches: readonly ChunkMatch[];
  readonly question: string;
}

/**
 * Ingest, search, answer — the demo, and it says so.
 *
 * **This is a demonstration that the parts connect.** Retrieval is a plain
 * similarity search: no reranking, no query rewriting, a chunking strategy not
 * worth the name and no evaluation of whether any of it helps. Saying that here
 * and in the contract is what stops it being copied into a product as though it
 * were one.
 *
 * What it *is* honest about is the plumbing: the tenant's own passages and
 * nobody else's, tokens metered against the organization that spent them, and
 * an answer that streams rather than arriving all at once after ten seconds.
 */
@Injectable()
export class RagService {
  private readonly db: Database;
  private readonly documents: AiRepository;
  private readonly ai: AiService;
  private readonly authz: AuthzService;
  private readonly config: AppConfig;

  constructor(
    @Inject(Database) db: Database,
    @Inject(AiRepository) documents: AiRepository,
    @Inject(AiService) ai: AiService,
    @Inject(AuthzService) authz: AuthzService,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.db = db;
    this.documents = documents;
    this.ai = ai;
    this.authz = authz;
    this.config = config;
  }

  /**
   * Cuts a document up, embeds the pieces and stores them.
   *
   * The embedding happens **outside** the transaction and the write inside it.
   * A provider that takes four seconds must not hold a database connection for
   * four seconds — at any concurrency worth having, that is the pool gone.
   */
  async ingest(
    principal: Principal,
    orgId: string,
    input: { title: string; source?: string; text: string },
  ): Promise<AiDocumentRecord> {
    this.authz.require(principal, 'note.create', { orgId });

    const passages = intoPassages(input.text);

    if (passages.length === 0) {
      throw new ForbiddenException(
        'There is nothing to ingest: the document is empty once whitespace is removed.',
      );
    }

    const embeddings = await this.ai.embedAll('rag.ingest', passages);

    return this.db.withRequestTransaction(async () => {
      const document = await this.documents.createDocument(orgId, {
        title: input.title,
        ...(input.source === undefined ? {} : { source: input.source }),
      });

      await this.documents.addChunks(
        orgId,
        document.id,
        passages.map((content, ordinal) => ({
          ordinal,
          content,
          embedding: embeddings[ordinal] as number[],
        })),
      );

      return { ...document, chunkCount: passages.length };
    });
  }

  async list(principal: Principal, orgId: string): Promise<AiDocumentRecord[]> {
    this.authz.require(principal, 'note.read', { orgId });

    return this.db.withRequestTransaction(() =>
      this.documents.listDocuments(orgId, LIST_LIMIT),
    );
  }

  async remove(principal: Principal, orgId: string, id: string): Promise<void> {
    this.authz.require(principal, 'note.delete', { orgId, resourceId: id });

    const removed = await this.db.withRequestTransaction(() =>
      this.documents.removeDocument(orgId, id),
    );

    if (!removed) {
      // Not a 403: telling a caller the id exists is telling them something
      // about another organization.
      throw new NotFoundException('No such document');
    }
  }

  /**
   * Refuses a question before anything is awaited.
   *
   * The permission and the provider both decide synchronously, and a streaming
   * route has to use them that way: everything decided after the first `await`
   * reaches the caller as an event on an open stream rather than as a status
   * code. What is left for `prepare` — the token ceiling — needs a database
   * read, and arrives as an `error` event. The contract says which is which.
   */
  assertCanAsk(principal: Principal, orgId: string): void {
    this.authz.require(principal, 'note.read', { orgId });
    this.ai.assertConfigured();
  }

  /**
   * Finds the passages a question should be answered from.
   *
   * Everything that can refuse happens here, and it happens before the caller
   * opens a stream: the permission, the provider being configured at all, and
   * the token ceiling are all reached through the embedding call. A refusal
   * after the response has started is a status line already sent and a caller
   * waiting on an event that is never coming.
   *
   * Each step is its own transaction. The provider call is the slow part, and
   * it has no business holding a database connection while it waits.
   */
  async prepare(
    principal: Principal,
    orgId: string,
    question: string,
  ): Promise<Retrieved> {
    this.authz.require(principal, 'note.read', { orgId });

    const [embedding] = await this.ai.embedAll('rag.question', [question]);

    const matches = await this.db.withRequestTransaction(() =>
      this.documents.search(
        orgId,
        embedding as number[],
        this.config.get('AI_SEARCH_LIMIT'),
      ),
    );

    return { citations: matches.map(toCitation), matches, question };
  }

  /**
   * Turns retrieved passages into an answer, a piece at a time.
   *
   * Called after the stream is open, so a failure here reaches the caller as a
   * stream that ends rather than as a status code — which is why everything
   * that *can* be a status code is in `prepare`.
   *
   * It takes neither the principal nor the organization: the permission was
   * decided in `assertCanAsk` before the stream opened, and the facade meters
   * against the request's own tenant. Carrying them here would be a second
   * source for a fact already settled.
   */
  async answer(
    retrieved: Retrieved,
    onText: (delta: string) => void,
  ): Promise<Answer> {
    if (retrieved.matches.length === 0) {
      // No passages means no grounded answer is possible, and asking the model
      // anyway produces a confident one from its own memory — which is the
      // failure this whole shape exists to avoid.
      return {
        text: 'There is nothing in this organization’s documents to answer that from.',
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    const answer = await this.ai.stream(
      {
        purpose: 'rag.answer',
        model: 'smart',
        system: SYSTEM_PROMPT,
        prompt: promptFrom(retrieved.question, retrieved.matches),
      },
      onText,
    );

    return {
      text: answer.text,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    };
  }

}

/**
 * The passages, numbered, above the question.
 *
 * Numbered so the model can cite them and a reader can check the citation
 * against the list the response already carried.
 */
function promptFrom(question: string, matches: readonly ChunkMatch[]): string {
  const passages = matches
    .map(
      (match, index) =>
        `[${String(index + 1)}] ${match.documentTitle}\n${match.content}`,
    )
    .join('\n\n');

  return `${passages}\n\nQuestion: ${question}`;
}

function toCitation(match: ChunkMatch): Citation {
  return {
    documentId: match.documentId,
    documentTitle: match.documentTitle,
    source: match.source,
    ordinal: match.ordinal,
    distance: match.distance,
  };
}
