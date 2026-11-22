import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

/**
 * Paranoid error surface.
 *
 * Internal failures never leak stack traces, SQL fragments or library messages
 * to the client: those are exactly the details that turn a bug into an
 * enumeration oracle. Everything unrecognised collapses to a generic 500 with a
 * correlation id that is logged server-side only.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (res.headersSent) return;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const normalised = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
      res.status(status).json({
        statusCode: status,
        code: (normalised.code as string) ?? codeForStatus(status),
        message: (normalised.message as string) ?? exception.message,
        requestId: (normalised.requestId as string) ?? undefined,
      });
      return;
    }

    const requestId = Math.random().toString(36).slice(2, 10);
    // eslint-disable-next-line no-console
    console.error(`[${requestId}] unhandled exception`, exception);

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      code: 'INTERNAL',
      message: 'Internal server error',
      requestId,
    });
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION';
    case 401:
      return 'INVALID_KEY';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL';
  }
}

/**
 * Zod validation at the controller boundary.
 *
 * `.strict()` everywhere by default so unexpected fields are rejected rather
 * than silently dropped — a mass-assignment guard that costs nothing.
 */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    throw error;
  }
}
