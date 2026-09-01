import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PROBLEM_CONTENT_TYPE, toProblemDetails } from './problem-details.js';

const TRACE_ID = 'trace-abc';
const INSTANCE = '/api/v1/items/1';

const context = { instance: INSTANCE, traceId: TRACE_ID };

describe('toProblemDetails', () => {
  it('maps a Nest exception to its status and a stable type', () => {
    const problem = toProblemDetails(new NotFoundException('No such item'), context);

    expect(problem.status).toBe(404);
    expect(problem.type).toBe('https://errors.example.com/not-found');
    expect(problem.title).toBe('Not Found');
  });

  it('carries the instance and trace id on every problem', () => {
    const problem = toProblemDetails(new NotFoundException(), context);

    expect(problem.instance).toBe(INSTANCE);
    expect(problem.traceId).toBe(TRACE_ID);
  });

  it('turns zod issues into field-level errors', () => {
    const schema = z.object({ email: z.string().email(), age: z.number().min(18) });
    const parsed = schema.safeParse({ email: 'not-an-email', age: 12 });

    const problem = toProblemDetails(parsed.error, context);

    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'email' }),
        expect.objectContaining({ path: 'age' }),
      ]),
    );
  });

  it('does not leak internal messages on an unexpected error', () => {
    const problem = toProblemDetails(
      new Error('connection string postgres://user:hunter2@db/app failed'),
      context,
    );

    expect(problem.status).toBe(500);
    expect(JSON.stringify(problem)).not.toContain('hunter2');
    expect(problem.detail).toBe('An unexpected error occurred.');
  });

  it('keeps the message of a deliberate client error', () => {
    const problem = toProblemDetails(
      new BadRequestException('Cursor does not match the current filters'),
      context,
    );

    expect(problem.detail).toBe('Cursor does not match the current filters');
  });

  it('unwraps a validation exception that carries a zod error', () => {
    // nestjs-zod throws its own HttpException wrapping the ZodError. Without
    // unwrapping, a validation failure would lose its field-level detail and
    // arrive as a bare 400.
    const schema = z.object({ title: z.string().min(1) });
    const parsed = schema.safeParse({ title: '' });

    class ZodValidationException extends BadRequestException {
      getZodError() {
        return parsed.error;
      }
    }

    const problem = toProblemDetails(new ZodValidationException(), context);

    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual([
      expect.objectContaining({ path: 'title' }),
    ]);
  });

  it('strips the exception class name from the message', () => {
    // Nest's ThrottlerException stringifies as "ThrottlerException: Too Many
    // Requests"; the class name is an implementation detail of ours.
    class ThrottlerException extends HttpException {
      constructor() {
        super('ThrottlerException: Too Many Requests', 429);
      }
    }

    const problem = toProblemDetails(new ThrottlerException(), context);

    expect(problem.detail).toBe('Too Many Requests');
  });

  it('uses the problem+json media type', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
  });
});
