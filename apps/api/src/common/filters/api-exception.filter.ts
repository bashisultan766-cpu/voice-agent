import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { safeRequestMeta } from '../logging/safe-log';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = isHttp ? exception.getResponse() : null;

    let message = 'Request failed.';
    let code: string | undefined;

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = safeRequestMeta(request.method, request.url);
      if (exception.code === 'P2002') {
        response.status(HttpStatus.CONFLICT).json({
          ok: false,
          error: {
            statusCode: HttpStatus.CONFLICT,
            message: 'A record with this value already exists.',
            code: 'DUPLICATE',
          },
          timestamp: new Date().toISOString(),
          path: request.url.split('?')[0],
        });
        this.logger.warn(JSON.stringify({ event: 'api.prisma_conflict', ...meta, prismaCode: exception.code }));
        return;
      }
      if (exception.code === 'P2025') {
        response.status(HttpStatus.NOT_FOUND).json({
          ok: false,
          error: {
            statusCode: HttpStatus.NOT_FOUND,
            message: 'The requested resource was not found.',
            code: 'NOT_FOUND',
          },
          timestamp: new Date().toISOString(),
          path: request.url.split('?')[0],
        });
        this.logger.warn(JSON.stringify({ event: 'api.prisma_not_found', ...meta, prismaCode: exception.code }));
        return;
      }
      this.logger.error(
        JSON.stringify({
          event: 'api.prisma_error',
          ...safeRequestMeta(request.method, request.url),
          prismaCode: exception.code,
        }),
      );
      response.status(HttpStatus.BAD_REQUEST).json({
        ok: false,
        error: {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'The request could not be completed. Please check your input.',
          code: 'DATABASE_ERROR',
        },
        timestamp: new Date().toISOString(),
        path: request.url.split('?')[0],
      });
      return;
    }

    if (typeof raw === 'string') {
      message = raw;
    } else if (raw && typeof raw === 'object' && 'message' in raw) {
      const obj = raw as unknown as Record<string, unknown>;
      const value = obj.message;
      code = typeof obj.code === 'string' ? obj.code : undefined;
      if (typeof value === 'string') message = value;
      else if (Array.isArray(value) && typeof value[0] === 'string') {
        message = value[0];
      }
    } else if (exception instanceof Error && exception.message) {
      message = exception.message;
    }

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          event: 'api.unhandled_error',
          ...safeRequestMeta(request.method, request.url),
          status,
          errorName: exception instanceof Error ? exception.name : 'unknown',
        }),
      );
      message = 'Something went wrong. Please try again.';
      code = code ?? 'INTERNAL_ERROR';
    }

    response.status(status).json({
      ok: false,
      error: {
        statusCode: status,
        message,
        ...(code ? { code } : {}),
      },
      timestamp: new Date().toISOString(),
      path: request.url.split('?')[0],
    });
  }
}
