import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { envSchema, type AppEnv } from './env.schema.js';

/**
 * Typed access to validated configuration.
 *
 * Application code injects this instead of reading `process.env`, so every
 * value it sees has been through the schema.
 */
export class AppConfig {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  get<K extends keyof AppEnv>(key: K): AppEnv[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
}

function validate(raw: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    // Nest prints this before exiting, so it must say which variables are wrong.
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return result.data;
}

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validate })],
  providers: [
    {
      provide: AppConfig,
      useFactory: (config: ConfigService<AppEnv, true>) => new AppConfig(config),
      inject: [ConfigService],
    },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
