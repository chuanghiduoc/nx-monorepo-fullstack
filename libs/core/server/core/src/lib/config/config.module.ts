import { Global, Module, type DynamicModule } from '@nestjs/common';
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

/**
 * A dynamic module rather than a static `@Module({ imports: [...] })`:
 * `ConfigModule.forRoot` reads and validates the environment the moment it
 * is called, and a decorator argument is evaluated when the file is imported.
 * That made importing a pure helper from this library's barrel — a cursor
 * codec, say — fail in any process without a full production environment,
 * such as a unit test. Validation now happens where it belongs: when the
 * application module is assembled.
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [ConfigModule.forRoot({ isGlobal: true, cache: true, validate })],
      providers: [
        {
          provide: AppConfig,
          useFactory: (config: ConfigService<AppEnv, true>) => new AppConfig(config),
          inject: [ConfigService],
        },
      ],
      exports: [AppConfig],
    };
  }
}
