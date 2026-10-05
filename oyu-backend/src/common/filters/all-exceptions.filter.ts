import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response, Request } from 'express';

/**
 * Некорректный ввод, дошедший до Prisma/Date, — ошибка клиента, а не сервера.
 * Детали не раскрываем (только общее сообщение).
 */
function clientError(e: unknown): { status: number; message: string } | null {
  const name = (e as { constructor?: { name?: string } })?.constructor?.name;
  if (name === 'PrismaClientValidationError') return { status: 400, message: 'Invalid request parameters' };
  if (name === 'ZodError') return { status: 400, message: 'Invalid request parameters' };
  // Postgres 22021: нулевой байт / невалидная UTF-8 последовательность в строковом параметре
  if (name === 'PrismaClientUnknownRequestError' && /22021|invalid byte sequence/i.test(String((e as Error).message))) {
    return { status: 400, message: 'Invalid request parameters' };
  }
  // Ошибки body-parser / http-errors (413 слишком большое тело, 400 битый JSON, 415 и т.п.)
  const s = (e as { status?: unknown; expose?: unknown }).status;
  if (typeof s === 'number' && s >= 400 && s < 500 && (e as { expose?: unknown }).expose === true) {
    return { status: s, message: s === 413 ? 'Payload too large' : 'Bad request' };
  }
  if (name === 'PrismaClientKnownRequestError') {
    const code = (e as { code?: string }).code;
    if (code === 'P2003') return { status: 404, message: 'Referenced resource not found' };
    if (code === 'P2023') return { status: 400, message: 'Invalid identifier' };
    if (code === 'P2025') return { status: 404, message: 'Not found' };
  }
  if (e instanceof RangeError && /Invalid time value|Invalid Date/i.test(e.message)) {
    return { status: 400, message: 'Invalid date or range' };
  }
  return null;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const client = exception instanceof HttpException ? null : clientError(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : client?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;

    const payload =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: client?.message ?? 'Internal server error' };

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : { message: String(payload) };

    // Единый формат: message всегда строка (массивы Nest/Zod склеиваем), детали — в details
    const rawMessage = body.message;
    const message = Array.isArray(rawMessage)
      ? rawMessage.join('; ')
      : typeof rawMessage === 'string'
        ? rawMessage
        : 'Error';

    res.status(status).json({
      ...body,
      statusCode: status,
      message,
      ...(Array.isArray(rawMessage) ? { details: rawMessage } : {}),
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
