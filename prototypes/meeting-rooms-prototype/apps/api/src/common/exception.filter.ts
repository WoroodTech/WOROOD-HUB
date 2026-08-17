import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Single error envelope for the whole API so the frontend has exactly one
 * shape to handle, and so internal details never leak to the browser.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let payload: Record<string, unknown> = {
      error: 'InternalServerError',
      message: 'An unexpected error occurred. Please try again.',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      payload =
        typeof body === 'string'
          ? { error: exception.name, message: body }
          : { error: exception.name, ...(body as Record<string, unknown>) };
    } else {
      this.logger.error(
        `${request.method} ${request.url} failed`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      ...payload,
    });
  }
}
