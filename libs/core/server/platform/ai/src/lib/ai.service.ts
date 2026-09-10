import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfig } from '@workspace/core-server-core';
import { METRICS, type Metrics } from '@workspace/core-server-observability';
import {
  Database,
  QuotaRepository,
} from '@workspace/core-server-data-access-db';
import { embed, embedMany, generateText, streamText } from 'ai';

import { AI_MODELS, type AiModels, type ModelAlias } from './ai.tokens.js';

/**
 * The entitlement the ceiling is read from and the usage recorded against.
 *
 * One counter for the ceiling and one per purpose for the breakdown. The
 * per-purpose counters have no ceiling of their own; they exist so "what is
 * this costing us, and where" has an answer that does not require reading the
 * code.
 */
export const AI_TOKENS = 'ai.tokens';

/** Everything a call needs beyond its prompt. */
export interface AiRequest {
  /**
   * What this call is for: `note.summary`, `rag.answer`.
   *
   * Not decoration — it is what usage is grouped by, and it is the only label
   * anybody will have when the bill arrives.
   */
  readonly purpose: string;
  readonly model: ModelAlias;
  readonly prompt: string;
  readonly system?: string;
}

export interface AiAnswer {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelId: string;
}

/**
 * The one door to a language model.
 *
 * **Feature code names a purpose and a policy alias, never a provider and never
 * a model.** `fast` and `smart` resolve from configuration, so changing what
 * `smart` means is a deployment decision rather than a code change and a
 * rebuild — and a call site that named `claude-sonnet-4-5` would be a call site
 * somebody has to find again when it is retired.
 *
 * **The organization is not a parameter.** It comes from the request this call
 * is being made for, which is where the quota counter reads it from too.
 * Passing it would be a second source for one fact, and the two would
 * eventually disagree in the direction of billing the wrong tenant.
 *
 * **The provider call is not inside a transaction, and the two quota
 * statements each open their own.** A model answers in seconds — a streamed
 * one in tens of them — and the workspace's transaction contract says never to
 * make a network call inside a transaction for exactly that reason: the
 * connection is held, and its pool slot with it, for as long as the provider
 * takes. It also could not work: Prisma's interactive transactions time out
 * after five seconds by default, so wrapping a stream meant the metering
 * rolled back on every answer slower than that — tokens spent, and no record
 * that they were.
 *
 * Every call is metered. Tokens go to the quota counters the workspace already
 * has, which is what makes per-organization metering possible without a second
 * mechanism; latency and the resolved model go to one structured log line,
 * because a counter holds one number and those are not it.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly models: AiModels | undefined;
  private readonly quota: QuotaRepository;
  private readonly config: AppConfig;
  private readonly db: Database;

  /**
   * The registry, when something is collecting.
   *
   * Optional because the facade has to work in a suite that builds it with
   * three arguments, and because a deployment that scrapes nothing is not a
   * broken one.
   */
  private readonly metrics: Metrics | undefined;

  constructor(
    @Optional() @Inject(AI_MODELS) models: AiModels | undefined,
    @Inject(QuotaRepository) quota: QuotaRepository,
    @Inject(AppConfig) config: AppConfig,
    @Inject(Database) db: Database,
    @Optional() @Inject(METRICS) metrics?: Metrics,
  ) {
    this.models = models;
    this.quota = quota;
    this.config = config;
    this.db = db;
    this.metrics = metrics;
  }

  /** Whether this deployment can answer at all. */
  get configured(): boolean {
    return this.models !== undefined;
  }

  /**
   * Refuses, synchronously, when nothing can answer.
   *
   * Public and separate from the calls because a streaming route has to decide
   * this *before* its first `await`. Measured: with a global interceptor in the
   * chain, Nest commits the SSE headers on the next macrotask, so a refusal
   * that comes after any real asynchronous work arrives as an `error` event on
   * a 200 rather than as a status code. A microtask rejection still beats it.
   */
  assertConfigured(): void {
    this.mustBeConfigured();
  }

  /**
   * One answer, waited for.
   *
   * The quota is checked before the provider is reached: an organization past
   * its ceiling must not spend money to be told no.
   */
  async generate(request: AiRequest): Promise<AiAnswer> {
    const models = this.mustBeConfigured();
    await this.mustBeUnderCeiling();

    const started = Date.now();

    try {
      const result = await generateText({
        model: models.language[request.model],
        ...(request.system === undefined ? {} : { system: request.system }),
        prompt: request.prompt,
      });

      const inputTokens = tokensOf(result.usage.inputTokens);
      const outputTokens = tokensOf(result.usage.outputTokens);

      await this.meter(request, {
        inputTokens,
        outputTokens,
        modelId: models.modelIds[request.model],
        latencyMs: Date.now() - started,
      });

      return {
        text: result.text,
        inputTokens,
        outputTokens,
        modelId: models.modelIds[request.model],
      };
    } catch (failure) {
      throw this.asProblem(failure, request);
    }
  }

  /**
   * The same call, streamed.
   *
   * Usage arrives at the end, so the record is written when the stream
   * *finishes*. A client that disconnects halfway leaves tokens spent and
   * recorded late or not at all — stated in the contract rather than papered
   * over, because there is no chunk carrying a number the provider has not
   * sent yet.
   */
  async stream(
    request: AiRequest,
    onText: (delta: string) => void,
  ): Promise<AiAnswer> {
    const models = this.mustBeConfigured();
    await this.mustBeUnderCeiling();

    const started = Date.now();

    try {
      const result = streamText({
        model: models.language[request.model],
        ...(request.system === undefined ? {} : { system: request.system }),
        prompt: request.prompt,
      });

      let text = '';

      for await (const delta of result.textStream) {
        text += delta;
        onText(delta);
      }

      const usage = await result.usage;
      const inputTokens = tokensOf(usage.inputTokens);
      const outputTokens = tokensOf(usage.outputTokens);

      await this.meter(request, {
        inputTokens,
        outputTokens,
        modelId: models.modelIds[request.model],
        latencyMs: Date.now() - started,
      });

      return {
        text,
        inputTokens,
        outputTokens,
        modelId: models.modelIds[request.model],
      };
    } catch (failure) {
      throw this.asProblem(failure, request);
    }
  }

  /** One vector for one piece of text. */
  async embedOne(purpose: string, value: string): Promise<number[]> {
    const [embedding] = await this.embedAll(purpose, [value]);

    if (embedding === undefined) {
      throw new ServiceUnavailableException(
        'The embedding model returned nothing for a value it was given.',
      );
    }

    return embedding;
  }

  /**
   * Vectors for many pieces at once, which is one request rather than many.
   *
   * `embedOne` goes through here rather than calling `embed` itself: two paths
   * would be two places for the metering to be forgotten, and the SDK splits a
   * large batch into requests the model will accept anyway.
   */
  async embedAll(
    purpose: string,
    values: readonly string[],
  ): Promise<number[][]> {
    const models = this.mustBeConfigured();

    if (values.length === 0) {
      return [];
    }

    await this.mustBeUnderCeiling();
    const started = Date.now();

    try {
      const result: EmbeddedBatch =
        values.length === 1
          ? await embedSingle(models, values[0] as string)
          : await embedBatch(models, values);

      await this.meter(
        { purpose, model: 'fast' },
        {
          inputTokens: result.tokens,
          outputTokens: 0,
          modelId: models.embeddingModelId,
          latencyMs: Date.now() - started,
        },
      );

      return result.embeddings;
    } catch (failure) {
      throw this.asProblem(failure, { purpose });
    }
  }

  private mustBeConfigured(): AiModels {
    if (this.models === undefined) {
      // Not a 500: nothing is broken. This deployment was started without a
      // provider, which is the shipped default, and saying which variable
      // turns it on is more use than a stack trace.
      throw new ServiceUnavailableException(
        'This deployment has no model provider configured. Set AI_PROVIDER and AI_API_KEY to turn it on.',
      );
    }

    return this.models;
  }

  /**
   * Refuses before the provider is reached.
   *
   * A read rather than a reservation, and the ceiling is therefore **soft**: a
   * completion's cost is not knowable before it exists, so two calls that both
   * start under the ceiling can both finish over it. Reserving a guess would
   * refuse work that fits whenever the guess was high and protect nothing
   * whenever it was low.
   *
   * Its own short transaction, opened and closed before the provider is
   * reached — the counter is read for the request's own organization, which is
   * what `withRequestTransaction` resolves.
   */
  private async mustBeUnderCeiling(): Promise<void> {
    const limit = this.config.get('AI_MONTHLY_TOKEN_LIMIT');
    const used = await this.db.withRequestTransaction(() =>
      this.quota.usage(AI_TOKENS, 'monthly'),
    );

    if (used >= limit) {
      // A tenant at its ceiling is a tenant that does not know, and nothing
      // else reports it: the request gets a 403 and the operator hears about
      // it from support.
      this.metrics?.quotaRejections.inc({ entitlement: AI_TOKENS });

      throw new ForbiddenException(
        `This organization has used ${String(used)} of its ${String(limit)} tokens this month.`,
      );
    }
  }

  /**
   * Counts what was spent, and says what it cost in a line somebody can read.
   *
   * `record` rather than `consume`: the tokens are already spent, and refusing
   * to count them because they went over would drop the number in exactly the
   * case where it matters most.
   */
  private async meter(
    request: Pick<AiRequest, 'purpose' | 'model'>,
    spent: {
      inputTokens: number;
      outputTokens: number;
      modelId: string;
      latencyMs: number;
    },
  ): Promise<void> {
    const total = spent.inputTokens + spent.outputTokens;

    // One short transaction for both counters, opened after the provider has
    // answered rather than around it. The two commit together: a total without
    // its breakdown, or a breakdown without its total, is a bill that does not
    // add up and nothing would say which half is missing.
    await this.db.withRequestTransaction(async () => {
      await this.quota.record({
        entitlement: AI_TOKENS,
        window: 'monthly',
        amount: total,
      });

      // A counter per purpose, with no ceiling of its own. Bounded by the
      // number of call sites in the code, which is a number a person chooses —
      // so this grows with the codebase rather than with traffic.
      await this.quota.record({
        entitlement: `${AI_TOKENS}:${request.purpose}`,
        window: 'monthly',
        amount: total,
      });
    });

    // Latency and the resolved model do not fit a counter and never will.
    // Phase 6 is where this line becomes a metric.
    this.logger.log(
      `${request.purpose} via ${request.model} (${spent.modelId}): ` +
        `${String(spent.inputTokens)} in, ${String(spent.outputTokens)} out, ` +
        `${String(spent.latencyMs)}ms`,
    );
  }

  /**
   * Turns a provider failure into something a caller can act on.
   *
   * A provider that is down, rate-limiting us or refusing our key is not the
   * caller's fault and not a bug in this service. The log line names the
   * purpose, because "the model call failed" in a log with a thousand lines a
   * minute names nothing.
   */
  private asProblem(failure: unknown, request: Pick<AiRequest, 'purpose'>): Error {
    if (failure instanceof ForbiddenException) {
      // The quota's own refusal, on its way out through the same catch. It is
      // the caller's answer, not a provider failure, and turning it into a 503
      // would tell an organization over its limit to try again shortly.
      return failure;
    }

    const reason = failure instanceof Error ? failure.message : String(failure);

    this.logger.error(`${request.purpose} failed: ${reason}`);

    return new ServiceUnavailableException(
      `The model could not answer "${request.purpose}" just now. Try again shortly.`,
    );
  }
}

/**
 * The token count, or zero.
 *
 * The SDK types every field of its usage as possibly undefined, because not
 * every provider reports every number. Zero is the honest reading — measured,
 * rather than assumed from a document describing a newer shape than the one
 * installed.
 */
function tokensOf(reported: number | undefined): number {
  return reported ?? 0;
}

/** What both embedding paths return, so the caller has one shape. */
interface EmbeddedBatch {
  readonly embeddings: number[][];
  readonly tokens: number;
}

/** One value. `embed` rather than `embedMany`, because that is the API for it. */
async function embedSingle(
  models: AiModels,
  value: string,
): Promise<EmbeddedBatch> {
  const result = await embed({ model: models.embedding, value });

  return { embeddings: [result.embedding], tokens: result.usage.tokens };
}

async function embedBatch(
  models: AiModels,
  values: readonly string[],
): Promise<EmbeddedBatch> {
  const result = await embedMany({
    model: models.embedding,
    values: [...values],
  });

  return { embeddings: result.embeddings, tokens: result.usage.tokens };
}
