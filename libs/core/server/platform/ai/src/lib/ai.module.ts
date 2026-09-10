import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { Global, Logger, Module, type DynamicModule } from '@nestjs/common';
import { AppConfig } from '@workspace/core-server-core';
import type { LanguageModel } from 'ai';

import { AiService } from './ai.service.js';
import { AI_MODELS, type AiModels } from './ai.tokens.js';

/**
 * Resolves the aliases once, at boot.
 *
 * **Every failure here is a boot failure**, with the name of the variable that
 * caused it. The alternative is a 500 on the first request that happens to ask
 * for the alias nobody configured — which, for `smart`, might be weeks after
 * the deployment that broke it.
 *
 * A deployment with no provider is not a failure. `AI_PROVIDER=none` is the
 * shipped default: a boilerplate that demanded an API key to start would be a
 * boilerplate nobody can run. One line is logged, the token is absent, and the
 * service refuses each call with the variable's name — the same shape the
 * erasure role uses.
 */
@Global()
@Module({})
export class AiModule {
  static forRoot(): DynamicModule {
    return {
      module: AiModule,
      providers: [
        {
          provide: AI_MODELS,
          inject: [AppConfig],
          useFactory: (config: AppConfig): AiModels | undefined =>
            resolveModels(config),
        },
        AiService,
      ],
      exports: [AiService, AI_MODELS],
    };
  }
}

/**
 * How a model id becomes a model, for whichever provider was named.
 *
 * **`openai.chat(...)` rather than `openai(...)`, and that is the point of
 * `AI_BASE_URL`.** Measured: the plain call targets OpenAI's Responses API at
 * `/v1/responses`, which is OpenAI's own and which an OpenAI-*compatible*
 * endpoint — a gateway, Ollama, vLLM, LM Studio — does not serve.
 * `/v1/chat/completions` is the one they all speak. A deployment pointing this
 * at anything but OpenAI would otherwise get a 404 from the provider and a
 * "the model could not answer" from us.
 */
function languageModelFactory(
  provider: 'anthropic' | 'openai',
  apiKey: string,
  baseURL: string | undefined,
): (modelId: string) => LanguageModel {
  if (provider === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey,
      ...(baseURL === undefined ? {} : { baseURL }),
    });

    return (modelId) => anthropic(modelId);
  }

  const openai = createOpenAI({
    apiKey,
    ...(baseURL === undefined ? {} : { baseURL }),
  });

  return (modelId) => openai.chat(modelId);
}

function resolveModels(config: AppConfig): AiModels | undefined {
  const logger = new Logger(AiModule.name);
  const provider = config.get('AI_PROVIDER');

  if (provider === 'none') {
    logger.log(
      'AI_PROVIDER is "none", so nothing answers. Set it and AI_API_KEY to turn the assistant on.',
    );
    return undefined;
  }

  const apiKey = config.get('AI_API_KEY');

  if (apiKey === undefined) {
    throw new Error(
      `AI_PROVIDER is "${provider}", so AI_API_KEY is required. Leave AI_PROVIDER unset to run without a model.`,
    );
  }

  const fast = config.get('AI_MODEL_FAST');
  const smart = config.get('AI_MODEL_SMART');
  const baseURL = config.get('AI_BASE_URL');

  const language = languageModelFactory(provider, apiKey, baseURL);

  // Embeddings are their own provider decision: Anthropic publishes no
  // embedding model, so a deployment answering with Claude still embeds with
  // something OpenAI-compatible — which is what the second base URL is for.
  const embeddingKey = config.get('AI_EMBEDDING_API_KEY') ?? apiKey;
  const embeddingBaseUrl = config.get('AI_EMBEDDING_BASE_URL');
  const embeddingModelId = config.get('AI_EMBEDDING_MODEL');

  const embeddings = createOpenAI({
    apiKey: embeddingKey,
    ...(embeddingBaseUrl === undefined ? {} : { baseURL: embeddingBaseUrl }),
  });

  logger.log(
    `Answering with ${provider}: fast is ${fast}, smart is ${smart}; embedding with ${embeddingModelId}.`,
  );

  return {
    provider,
    language: { fast: language(fast), smart: language(smart) },
    modelIds: { fast, smart },
    embedding: embeddings.textEmbeddingModel(embeddingModelId),
    embeddingModelId,
  };
}
