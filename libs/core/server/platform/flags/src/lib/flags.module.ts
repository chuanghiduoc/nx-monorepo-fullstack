import { Module } from '@nestjs/common';

import { FeatureFlags } from './feature-flags.service.js';
import { DatabaseFlagProvider } from './flag.provider.js';
import { GlobalFlagCache } from './global-flags.cache.js';

const EXPORTED = [FeatureFlags, DatabaseFlagProvider, GlobalFlagCache];

/**
 * Feature flags, read from this database.
 *
 * It does not import `DatabaseModule`: both applications already register it
 * once, and importing it again here would build a second Prisma client with a
 * second connection pool — invisible until the pool arithmetic the worker
 * asserts at boot turned out to be counting half the connections.
 *
 * `DatabaseFlagProvider` is exported as well as `FeatureFlags`, because it is
 * the thing to hand to `OpenFeature.setProvider` for anyone who wants the
 * global client. This module deliberately does not make that call itself.
 */
@Module({
  providers: EXPORTED,
  exports: EXPORTED,
})
export class FlagsModule {}
