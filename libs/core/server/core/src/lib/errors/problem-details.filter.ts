import {
  Catch,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { REQUEST_ID_HEADER } from '../logging/request-id.js';
import {
  PROBLEM_CONTENT_TYPE,
  toProblemDetails,
  type ProblemDetails,
} from './problem-details.js';

const RETRY_AFTER_HEADER = 'retry-after';
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * The single place that turns an exception into a response.
 *
 * Every error leaves the service in the same shape, so a client writes one
 * handler and a log search finds every failure the same way.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const problem = toProblemDetails(exception, {
      instance: request.url,
      traceId: String(request.id),
    });

    this.log(exception, problem);

    reply
      .status(problem.status)
      .header('content-type', PROBLEM_CONTENT_TYPE)
      .header(REQUEST_ID_HEADER, problem.traceId);

    if (problem.status === HttpStatus.TOO_MANY_REQUESTS) {
      // Without this a client can only guess when to retry, and guessing means
      // hammering the endpoint that just asked it to stop. The throttler sets a
      // window-accurate value when it can; the constant is the fallback.
      if (!reply.getHeader(RETRY_AFTER_HEADER)) {
        reply.header(RETRY_AFTER_HEADER, DEFAULT_RETRY_AFTER_SECONDS);
      }
    }

    reply.send(problem);
  }

  /**
   * Client mistakes are noise at error level; server failures are the signal.
   * The full exception is logged either way, so nothing is lost by keeping the
   * response generic.
   */
  private log(exception: unknown, problem: ProblemDetails): void {
    const message = `${problem.status} ${problem.title} ${problem.instance}`;

    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(message, exception instanceof Error ? exception.stack : exception);
      return;
    }

    this.logger.debug(message);
  }
}
