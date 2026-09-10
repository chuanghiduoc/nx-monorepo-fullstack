import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { z } from 'zod';

import {
  envSchema,
  workerEnvSchema,
  type AppEnv,
  type BaseEnv,
  type WorkerEnv,
} from './env.schema.js';

/**
 * The configuration every backend process has.
 *
 * Shared modules — logging, and anything else that has to work in the API and
 * in the worker alike — inject this rather than one of the two below. They
 * then see exactly the keys both processes actually validate, so moving a key
 * out of the base breaks the compile instead of returning `undefined` in
 * whichever process was not thought about.
 */
export class BaseConfig {
  protected readonly config: ConfigService<BaseEnv, true>;

  constructor(config: ConfigService<BaseEnv, true>) {
    this.config = config;
  }

  get<K extends keyof BaseEnv>(key: K): BaseEnv[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
}

/**
 * Typed access to the API's validated configuration.
 *
 * Application code injects this instead of reading `process.env`, so every
 * value it sees has been through the schema.
 *
 * A separate class rather than a type parameter on `BaseConfig`: the class is
 * the DI token, a type parameter is erased, and the two processes would then
 * share one token whose default type promised the API's keys everywhere. A
 * worker asking for a signing key would have typechecked and returned
 * `undefined` — which is the failure the whole idea of validated configuration
 * exists to prevent.
 */
export class AppConfig extends BaseConfig {
  private readonly api: ConfigService<AppEnv, true>;

  constructor(config: ConfigService<AppEnv, true>) {
    super(config);
    this.api = config;
  }

  override get<K extends keyof AppEnv>(key: K): AppEnv[K] {
    return this.api.get(key, { infer: true });
  }
}

/** Typed access to the worker's validated configuration. */
export class WorkerConfig extends BaseConfig {
  private readonly worker: ConfigService<WorkerEnv, true>;

  constructor(config: ConfigService<WorkerEnv, true>) {
    super(config);
    this.worker = config;
  }

  override get<K extends keyof WorkerEnv>(key: K): WorkerEnv[K] {
    return this.worker.get(key, { infer: true });
  }
}

/**
 * An empty value is an absent one.
 *
 * There is no way to say "leave this unset" in a Compose `environment:` map:
 * `${VAR:-}` sets it to the empty string, which a schema then reads as present
 * and, for a URL or a non-empty string, invalid. Measured: `pnpm prod:up`
 * refused to start with `S3_ENDPOINT: Invalid URL` on a stack that had
 * deliberately configured no object store at all.
 *
 * Dropping empty values is also what every other tool in this chain already
 * does — a shell, a `.env` file, and Docker's own `--env-file` all treat an
 * empty assignment as nothing — so this makes the schema agree with them
 * rather than inventing a rule.
 *
 * A variable that genuinely means "empty string" would be broken by this. There
 * is none, and a schema that wanted one would have to say so with a default.
 *
 * **`process.env` is emptied of them too**, and that side effect is the point.
 * `ConfigService.get` falls back to `process.env` for anything the validated
 * object does not hold, so filtering only the copy fixed nothing: measured, the
 * realtime bus still read `REALTIME_REDIS_URL` as `''`, fell past its `??`
 * fallback, and opened four connections to `localhost:6379` in a container that
 * has no Redis. A process should agree with itself about which variables are
 * set.
 */
function withoutEmptyValues(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === '') {
      delete process.env[key];
      continue;
    }

    kept[key] = value;
  }

  return kept;
}

export function validator<Schema extends z.ZodType>(schema: Schema) {
  return (raw: Record<string, unknown>): z.infer<Schema> => {
    const result = schema.safeParse(withoutEmptyValues(raw));

    if (!result.success) {
      // Nest prints this before exiting, so it must say which variables are wrong.
      const problems = result.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');

      throw new Error(`Invalid environment configuration:\n${problems}`);
    }

    return result.data;
  };
}

/**
 * A dynamic module rather than a static `@Module({ imports: [...] })`:
 * `ConfigModule.forRoot` reads and validates the environment the moment it
 * is called, and a decorator argument is evaluated when the file is imported.
 * That made importing a pure helper from this library's barrel — a cursor
 * codec, say — fail in any process without a full production environment,
 * such as a unit test. Validation now happens where it belongs: when the
 * application module is assembled.
 *
 * Two entry points rather than one taking a schema, so the choice of schema is
 * a name at the call site instead of an argument somebody can get wrong.
 */
@Global()
@Module({})
export class AppConfigModule {
  /** The API: validates the full schema and provides `AppConfig`. */
  static forRoot(): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          validate: validator(envSchema),
        }),
      ],
      providers: [
        {
          provide: AppConfig,
          useFactory: (config: ConfigService<AppEnv, true>) =>
            new AppConfig(config),
          inject: [ConfigService],
        },
        // So a shared module can inject the base without knowing which process
        // it is in, and still receive the one instance this process validated.
        { provide: BaseConfig, useExisting: AppConfig },
      ],
      exports: [AppConfig, BaseConfig],
    };
  }

  /** The worker: validates the worker's schema and provides `WorkerConfig`. */
  static forWorker(): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          validate: validator(workerEnvSchema),
        }),
      ],
      providers: [
        {
          provide: WorkerConfig,
          useFactory: (config: ConfigService<WorkerEnv, true>) =>
            new WorkerConfig(config),
          inject: [ConfigService],
        },
        { provide: BaseConfig, useExisting: WorkerConfig },
      ],
      exports: [WorkerConfig, BaseConfig],
    };
  }
}
