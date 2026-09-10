import type { EmbeddingModel, LanguageModel } from 'ai';

/**
 * The two policy aliases, and the whole vocabulary a caller has.
 *
 * Not model names, and deliberately not more of them. `fast` and `smart` are a
 * decision about cost and latency; a third alias would be a third decision
 * nobody has a rule for, and a hundred would be model names with extra steps.
 */
export type ModelAlias = 'fast' | 'smart';

/**
 * What the deployment resolved its aliases to.
 *
 * A provider token rather than a service that builds models on demand: the
 * resolution happens once, at boot, so an alias that names nothing fails there
 * with the variable's name instead of on the first request weeks later.
 *
 * `undefined` means this deployment has no provider configured, which is the
 * shipped default and a real state rather than a broken one.
 */
export interface AiModels {
  readonly provider: string;
  readonly language: Readonly<Record<ModelAlias, LanguageModel>>;
  readonly modelIds: Readonly<Record<ModelAlias, string>>;
  readonly embedding: EmbeddingModel;
  readonly embeddingModelId: string;
}

export const AI_MODELS = Symbol('AI_MODELS');
