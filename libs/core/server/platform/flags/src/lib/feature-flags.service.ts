import { Inject, Injectable } from '@nestjs/common';
import type { EvaluationContext, JsonValue } from '@openfeature/server-sdk';

import { DatabaseFlagProvider, ORG_TARGETING_KEY } from './flag.provider.js';

/**
 * Reading a flag, without an OpenFeature client.
 *
 * The provider is the standard-shaped thing; this is the small surface a
 * handler actually calls. It exists so a caller never has to think about
 * `ResolutionDetails`, and so nothing in this workspace depends on
 * `OpenFeature.setProvider` having been called — which is process-global
 * state, and the reason two test suites in one process would fight.
 *
 * The `*Details` variants return the resolution as OpenFeature reports it, for
 * the caller that wants to log *why* it got what it got. That is the difference
 * between "the flag is off" and "the database was unreachable and the default
 * is off", and during an incident it is the only difference that matters.
 */
@Injectable()
export class FeatureFlags {
  private readonly provider: DatabaseFlagProvider;

  constructor(@Inject(DatabaseFlagProvider) provider: DatabaseFlagProvider) {
    this.provider = provider;
  }

  async boolean(
    key: string,
    fallback: boolean,
    orgId?: string,
  ): Promise<boolean> {
    const resolved = await this.provider.resolveBooleanEvaluation(
      key,
      fallback,
      contextFor(orgId),
    );

    return resolved.value;
  }

  async string(key: string, fallback: string, orgId?: string): Promise<string> {
    const resolved = await this.provider.resolveStringEvaluation(
      key,
      fallback,
      contextFor(orgId),
    );

    return resolved.value;
  }

  async number(key: string, fallback: number, orgId?: string): Promise<number> {
    const resolved = await this.provider.resolveNumberEvaluation(
      key,
      fallback,
      contextFor(orgId),
    );

    return resolved.value;
  }

  async object<T extends JsonValue>(
    key: string,
    fallback: T,
    orgId?: string,
  ): Promise<T> {
    const resolved = await this.provider.resolveObjectEvaluation(
      key,
      fallback,
      contextFor(orgId),
    );

    return resolved.value;
  }

  /** The same evaluation, with the reason it came out that way. */
  async booleanDetails(key: string, fallback: boolean, orgId?: string) {
    return this.provider.resolveBooleanEvaluation(
      key,
      fallback,
      contextFor(orgId),
    );
  }
}

/**
 * An empty context when no organization was named.
 *
 * Empty rather than absent, because the provider then falls back to the
 * ambient request context — which is what lets an ordinary handler ask for a
 * flag with no arguments and still get its own tenant's answer.
 */
function contextFor(orgId: string | undefined): EvaluationContext {
  return orgId === undefined ? {} : { [ORG_TARGETING_KEY]: orgId };
}
