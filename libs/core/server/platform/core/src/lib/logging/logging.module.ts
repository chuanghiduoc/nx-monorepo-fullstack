import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pretty from 'pino-pretty';

import { AppConfig } from '../config/config.module.js';
import { REDACTED_PATHS, REDACTION_CENSOR } from './redaction.js';

/**
 * Structured logging.
 *
 * JSON to stdout wherever the service runs in a container — the platform
 * collects stdout, and a log line is only useful if a machine can filter it.
 * Pretty printing exists for the local loop, where a human reads it.
 *
 * The request id comes from the Fastify adapter (see request-id.ts); pino-http
 * reads it from `request.id`, and the same id goes back on the response, so
 * "this request failed" can be traced without guessing.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        // A destination stream, not a transport: pino transports run in a worker
        // thread that resolves its entry by file path, which does not survive
        // webpack bundling (the bundle looks for dist/lib/worker.js).
        pinoHttp: [
          {
            level: config.get('LOG_LEVEL'),

            // Credentials must never reach a log aggregator. The list lives in
            // redaction.ts and is covered by a test that reads real log output.
            redact: { paths: [...REDACTED_PATHS], censor: REDACTION_CENSOR },
          },
          config.isProduction
            ? process.stdout
            : pretty({ singleLine: true, colorize: true }),
        ],
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
