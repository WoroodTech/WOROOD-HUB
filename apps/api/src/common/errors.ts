import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

/** One JSON envelope for every failure, so the portal has exactly one error
 *  shape to handle and internal detail never reaches the browser. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const status = exception instanceof HttpException
      ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Something went wrong';
    let details: unknown;
    if (exception instanceof HttpException) {
      const body = exception.getResponse() as any;
      message = typeof body === 'string' ? body : body.message ?? exception.message;
      if (Array.isArray(message)) { details = message; message = message[0]; }
    } else {
      this.logger.error(`${req.method} ${req.url}`,
        exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(status).json({
      error: { status, message, details, path: req.url, at: new Date().toISOString() },
    });
  }
}
