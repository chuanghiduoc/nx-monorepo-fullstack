import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodError } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Where error types are published. Overridden per deployment. */
const TYPE_BASE_URL = process.env['PROBLEM_TYPE_BASE_URL'] ?? 'https://errors.example.com';

const GENERIC_SERVER_MESSAGE = 'An unexpected error occurred.';

/**
 * A single field-level validation failure.
 *
 * `path` is dotted rather than an array so a client can display it without
 * reassembling anything.
 */
export interface ProblemError {
  path: string;
  message: string;
}

/** RFC 9457 problem document, plus the two extensions this platform adds. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  /** Field-level failures, present only for validation problems. */
  errors?: ProblemError[];
  /** Correlates the response with logs and traces. */
  traceId: string;
}

export interface ProblemContext {
  instance: string;
  traceId: string;
}

const TITLES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Content',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

function typeUrlFor(status: number): string {
  const slug = (TITLES[status] ?? 'error').toLowerCase().replace(/\s+/g, '-');
  return `${TYPE_BASE_URL}/${slug}`;
}

interface CarriesZodError {
  getZodError(): ZodError;
}

function unwrapZodError(exception: unknown): ZodError | undefined {
  if (exception instanceof ZodError) return exception;

  const candidate = exception as Partial<CarriesZodError>;

  if (typeof candidate?.getZodError === 'function') {
    const inner = candidate.getZodError();
    if (inner instanceof ZodError) return inner;
  }

  return undefined;
}

function detailFrom(exception: HttpException): string {
  const response = exception.getResponse();

  if (typeof response === 'string') return response;

  const message = (response as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');

  return exception.message;
}

/**
 * Converts anything thrown into one response shape.
 *
 * Deliberate client errors keep their message — the caller needs it to fix the
 * request. Everything else is reported generically: an unexpected error's
 * message can contain connection strings, file paths or third-party detail, and
 * the client can do nothing with it anyway. The full error still reaches the
 * logs, keyed by the same trace id.
 */
export function toProblemDetails(
  exception: unknown,
  context: ProblemContext,
): ProblemDetails {
  // Validation pipes wrap the ZodError in their own exception. Unwrapping by
  // shape rather than by class keeps this library independent of which pipe the
  // application chose, while still preserving field-level detail.
  const zodError = unwrapZodError(exception);

  if (zodError) {
    return {
      type: typeUrlFor(HttpStatus.BAD_REQUEST),
      title: TITLES[HttpStatus.BAD_REQUEST],
      status: HttpStatus.BAD_REQUEST,
      detail: 'The request failed validation.',
      instance: context.instance,
      errors: zodError.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      traceId: context.traceId,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();

    return {
      type: typeUrlFor(status),
      title: TITLES[status] ?? 'Error',
      status,
      detail: detailFrom(exception),
      instance: context.instance,
      traceId: context.traceId,
    };
  }

  return {
    type: typeUrlFor(HttpStatus.INTERNAL_SERVER_ERROR),
    title: TITLES[HttpStatus.INTERNAL_SERVER_ERROR],
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    detail: GENERIC_SERVER_MESSAGE,
    instance: context.instance,
    traceId: context.traceId,
  };
}
