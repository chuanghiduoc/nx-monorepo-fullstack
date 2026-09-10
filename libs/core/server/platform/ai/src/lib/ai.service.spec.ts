import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '@workspace/core-server-core';
import type {
  Database,
  QuotaRepository,
} from '@workspace/core-server-data-access-db';
import { simulateReadableStream } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import { AI_TOKENS, AiService } from './ai.service.js';
import type { AiModels } from './ai.tokens.js';

const MONTHLY_LIMIT = 1_000;

/**
 * What the fake counter recorded, and what it claims has been used.
 *
 * A spy rather than a database: what the counter does with a number is proven
 * against a real PostgreSQL in the quota repository's own suite. What is worth
 * testing here is which numbers reach it, and when.
 */
function quotaWith(used = 0) {
  const record = vi.fn().mockResolvedValue(undefined);
  const usage = vi.fn().mockResolvedValue(used);

  return {
    quota: { record, usage } as unknown as QuotaRepository,
    record,
    usage,
  };
}

function configWith(limit = MONTHLY_LIMIT): AppConfig {
  return {
    get: (key: string) =>
      key === 'AI_MONTHLY_TOKEN_LIMIT' ? limit : undefined,
  } as unknown as AppConfig;
}

/**
 * A database whose transactions run their callback and nothing else.
 *
 * What the counter does with a number is proven against a real PostgreSQL in
 * the quota repository's own suite. What matters here is which numbers reach
 * it, and — in the test at the bottom of this file — that the provider is
 * never reached from inside one of these.
 */
function databaseThatRuns(): Database {
  return {
    withRequestTransaction: <T>(work: () => Promise<T>) => work(),
  } as unknown as Database;
}

/**
 * A deployment whose aliases resolve to models that answer without a network.
 *
 * `ai/test` is why every test here is fast, deterministic and free. A suite
 * that reached a real provider would be none of those, and could not run in CI
 * without a key.
 *
 * **V4 and not V3, measured.** `MockLanguageModelV3` drops its usage on the way
 * through this SDK version — `result.usage` comes back with no token counts at
 * all — so a suite written against it would assert zeros and prove that the
 * metering reads nothing. The model-side shape is nested; the result's is flat.
 */
interface TokenOptions {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Usage in the shape a V4 model reports it.
 *
 * Every field spelled out, including the ones no provider fills in: the type
 * requires them, and a partial object is the kind of thing that compiles here
 * and fails in whatever reads it next.
 */
function usageOf(options: TokenOptions) {
  const input = options.inputTokens ?? 10;
  const output = options.outputTokens ?? 20;

  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function modelsWith(options: {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  fails?: boolean;
  /** Called as the provider is reached, so a test can see what was open. */
  onGenerate?: () => void;
}): AiModels {
  const doGenerate = async () => {
    options.onGenerate?.();

    if (options.fails === true) {
      throw new Error('the provider is unavailable');
    }

    return {
      content: [{ type: 'text' as const, text: options.text ?? 'an answer' }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: usageOf(options),
      warnings: [],
    };
  };

  const model = new MockLanguageModelV4({
    doGenerate,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start' as const, id: '1' },
          { type: 'text-delta' as const, id: '1', delta: 'one ' },
          { type: 'text-delta' as const, id: '1', delta: 'two' },
          { type: 'text-end' as const, id: '1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: usageOf(options),
          },
        ],
      }),
    }),
  });

  return {
    provider: 'mock',
    language: { fast: model, smart: model },
    modelIds: { fast: 'mock-fast', smart: 'mock-smart' },
    embedding: new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => ({
        embeddings: values.map(() => [0.1, 0.2, 0.3]),
        usage: { tokens: 7 },
        // Required by the type even though no provider fills it in here.
        warnings: [],
      }),
    }),
    embeddingModelId: 'mock-embedding',
  };
}

describe('AiService', () => {
  it('answers through the alias, not through a model name', async () => {
    const { quota } = quotaWith();
    const ai = new AiService(modelsWith({ text: 'hello' }), quota, configWith(), databaseThatRuns());

    const answer = await ai.generate({
      purpose: 'test.answer',
      model: 'smart',
      prompt: 'hi',
    });

    // The alias is the caller's whole vocabulary; what it resolved to comes
    // back so a log line can say, and so nothing has to ask the configuration.
    expect(answer.text).toBe('hello');
    expect(answer.modelId).toBe('mock-smart');
  });

  it('records what the model reported, not zeros', async () => {
    const { quota, record } = quotaWith();
    const ai = new AiService(
      modelsWith({ inputTokens: 130, outputTokens: 47 }),
      quota,
      configWith(),
      databaseThatRuns(),
    );

    await ai.generate({ purpose: 'test.answer', model: 'fast', prompt: 'hi' });

    // The shape of `usage` changed between SDK majors, and reading the old one
    // records zeros silently — metering that looks like it works and meters
    // nothing. Both numbers are asserted for that reason.
    expect(record).toHaveBeenCalledWith({
      entitlement: AI_TOKENS,
      window: 'monthly',
      amount: 177,
    });
  });

  it('records the same tokens against the purpose as well', async () => {
    const { quota, record } = quotaWith();
    const ai = new AiService(modelsWith({}), quota, configWith(), databaseThatRuns());

    await ai.generate({ purpose: 'note.summary', model: 'fast', prompt: 'hi' });

    // "What is this costing us, and where" — answerable without reading code.
    expect(record).toHaveBeenCalledWith({
      entitlement: `${AI_TOKENS}:note.summary`,
      window: 'monthly',
      amount: 30,
    });
  });

  it('refuses before the provider is reached when the ceiling is spent', async () => {
    const { quota } = quotaWith(MONTHLY_LIMIT);
    const models = modelsWith({});
    const ai = new AiService(models, quota, configWith(), databaseThatRuns());

    await expect(
      ai.generate({ purpose: 'test.answer', model: 'fast', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // An organization past its ceiling must not spend money to be told no.
    expect((models.language.fast as MockLanguageModelV4).doGenerateCalls).toHaveLength(0);
  });

  it('allows the call that sits exactly under the ceiling', async () => {
    const { quota } = quotaWith(MONTHLY_LIMIT - 1);
    const ai = new AiService(modelsWith({}), quota, configWith(), databaseThatRuns());

    // `used >= limit` refuses; one token short of it does not. The boundary is
    // the kind of thing a refactor flips without noticing.
    await expect(
      ai.generate({ purpose: 'test.answer', model: 'fast', prompt: 'hi' }),
    ).resolves.toBeDefined();
  });

  it('turns a provider failure into something a caller can act on', async () => {
    const { quota } = quotaWith();
    const ai = new AiService(modelsWith({ fails: true }), quota, configWith(), databaseThatRuns());

    // Not a 500 with a stack trace: a provider that is down is nobody's bug.
    await expect(
      ai.generate({ purpose: 'test.answer', model: 'fast', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('records nothing when the provider failed', async () => {
    const { quota, record } = quotaWith();
    const ai = new AiService(modelsWith({ fails: true }), quota, configWith(), databaseThatRuns());

    await expect(
      ai.generate({ purpose: 'test.answer', model: 'fast', prompt: 'hi' }),
    ).rejects.toThrow();

    expect(record).not.toHaveBeenCalled();
  });

  it('refuses with the variable’s name when no provider is configured', async () => {
    const { quota } = quotaWith();
    const ai = new AiService(undefined, quota, configWith(), databaseThatRuns());

    expect(ai.configured).toBe(false);
    await expect(
      ai.generate({ purpose: 'test.answer', model: 'fast', prompt: 'hi' }),
    ).rejects.toThrow(/AI_PROVIDER/);
  });

  it('streams the text as it arrives and meters at the end', async () => {
    const { quota, record } = quotaWith();
    const ai = new AiService(modelsWith({}), quota, configWith(), databaseThatRuns());
    const deltas: string[] = [];

    const answer = await ai.stream(
      { purpose: 'rag.answer', model: 'smart', prompt: 'hi' },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(['one ', 'two']);
    expect(answer.text).toBe('one two');
    // Usage arrives at the end, so the record is written when the stream
    // finishes — which is why an abandoned stream is metered late or not at
    // all, and why the contract says so.
    expect(record).toHaveBeenCalledWith({
      entitlement: AI_TOKENS,
      window: 'monthly',
      amount: 30,
    });
  });

  it('embeds many values in one request and meters it once', async () => {
    const { quota, record } = quotaWith();
    const ai = new AiService(modelsWith({}), quota, configWith(), databaseThatRuns());

    const vectors = await ai.embedAll('rag.ingest', ['a', 'b', 'c']);

    expect(vectors).toHaveLength(3);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('embeds nothing, and reaches no provider, for an empty list', async () => {
    const { quota, record, usage } = quotaWith();
    const ai = new AiService(modelsWith({}), quota, configWith(), databaseThatRuns());

    expect(await ai.embedAll('rag.ingest', [])).toEqual([]);

    // Not even the ceiling is read: there is nothing to spend.
    expect(usage).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('gives one value one vector', async () => {
    const { quota } = quotaWith();
    const ai = new AiService(modelsWith({}), quota, configWith(), databaseThatRuns());

    expect(await ai.embedOne('rag.question', 'what?')).toEqual([0.1, 0.2, 0.3]);
  });

  it('reaches the provider with no transaction open', async () => {
    const { quota, record, usage } = quotaWith();

    let depth = 0;
    let depthAtProvider = -1;

    const db = {
      withRequestTransaction: async <T>(work: () => Promise<T>) => {
        depth += 1;
        try {
          return await work();
        } finally {
          depth -= 1;
        }
      },
    } as unknown as Database;

    const ai = new AiService(
      modelsWith({
        onGenerate: () => {
          depthAtProvider = depth;
        },
      }),
      quota,
      configWith(),
      db,
    );

    await ai.generate({ purpose: 'test.answer', model: 'fast', prompt: 'hi' });

    // The ceiling was read and the tokens were recorded, each in a transaction
    // of its own — and the model was reached between them, with none open.
    //
    // Wrapped, this held a connection and its pool slot for as long as the
    // provider took, against a contract that says never to make a network call
    // inside a transaction. It also could not work: Prisma's interactive
    // transactions time out after five seconds, so a streamed answer slower
    // than that rolled the metering back — tokens spent, nothing recorded.
    expect(usage).toHaveBeenCalled();
    expect(record).toHaveBeenCalled();
    expect(depthAtProvider).toBe(0);
  });
});
